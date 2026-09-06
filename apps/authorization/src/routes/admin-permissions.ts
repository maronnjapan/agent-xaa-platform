import { Hono, type Context } from 'hono';
import { readFormInput, wantsJson, type AdminInput } from '@xaa/admin-ui';
import { assertValidCapabilityId } from '@xaa/contracts';
import type { AdminConsoleVariables } from '@xaa/control-plane-auth';
import type { Logger } from '@xaa/logging';
import type { DocumentStore } from '@xaa/gcp';
import { parsePermission } from '../admin/permission.js';
import {
  createPermissionAdminStore, PermissionExists, PermissionInUse,
  type PermissionAdminStore, type PermissionView,
} from '../admin/permission-store.js';
import { createHolderAdminStore, type HolderAdminStore } from '../admin/holder-store.js';
import { holderPage, permissionDeletePage, permissionFormPage, permissionListPage } from '../admin/pages.js';
import { PERM_SET_ACTIONS, type PermSetAction } from '../perm-set.js';
import { claimPermissionChange } from '../reevaluate/idempotency.js';
import { reevaluate, type ReevaluateDeps } from '../reevaluate/reevaluate.js';

export interface AdminPermissionRouteDeps {
  documents: DocumentStore;
  logger: Logger;
  /**
   * What a permission change has to reach once the row is written (RULE-14). It is the
   * same set of dependencies the Pub/Sub route uses, and deliberately so: the console
   * and a `pnpm perm:set` announcement must not be two different re-evaluations.
   */
  reevaluation: ReevaluateDeps;
  store?: PermissionAdminStore;
  holders?: HolderAdminStore;
}

type Env = AdminConsoleVariables;

const LIST_PATH = '/admin/permissions';
const HOLDER_PATH = '/admin/holders';

/**
 * The permission screens (docs 03 §2).
 *
 * The Capability Taxonomy is the unit every permission in this platform is expressed
 * in — Human Permission, Delegatable Permission, Organization Policy and the decisions
 * themselves — so this is where a permission is created, changed and retired, and where
 * it is handed to a person or taken back.
 *
 * Every route answers a browser or a script from the same handler: a form post gets a
 * redirect back to the list, `Accept: application/json` gets the record. Two route
 * tables for one operation is how a console and its API drift into disagreeing about
 * what a permission is.
 */
export function createAdminPermissionRoutes(deps: AdminPermissionRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const store = deps.store ?? createPermissionAdminStore(deps.documents);
  const holders = deps.holders ?? createHolderAdminStore(deps.documents);

  app.get('/', (context) => context.redirect(LIST_PATH, 302));

  app.get('/permissions', async (context) => {
    const permissions = await store.list();
    if (wantsJson(context.req.raw)) return context.json({ permissions }, 200);
    return context.html(permissionListPage(permissions));
  });

  // Registered before `/permissions/:capability_id`, which would otherwise read `new`
  // as an id and answer 404 for the page that creates one.
  app.get('/permissions/new', (context) => context.html(permissionFormPage({})));

  app.get('/permissions/:capability_id', async (context) => {
    const permission = await store.find(context.req.param('capability_id'));
    if (!permission) return notFound(context);
    if (wantsJson(context.req.raw)) return context.json(permission, 200);
    return context.html(permissionFormPage({ permission }));
  });

  /**
   * The question before a deletion. It is a GET because it changes nothing: a person who
   * arrives here by following a link, or by reloading, has not deleted anything yet.
   */
  app.get('/permissions/:capability_id/delete', async (context) => {
    const permission = await store.find(context.req.param('capability_id'));
    if (!permission) return notFound(context);
    return context.html(permissionDeletePage({ permission }));
  });

  app.post('/permissions', async (context) => {
    const input = await readFormInput(context.req.raw);
    const parsed = parsePermission(input);
    if (!parsed.ok) return invalid(context, parsed.errors, { values: input });

    try {
      await store.create(parsed.permission);
    } catch (error) {
      if (error instanceof PermissionExists) {
        return invalid(context, [`${error.capability_id} はすでにある。編集する場合は一覧から開く。`], { values: input, status: 409 });
      }
      throw error;
    }
    audit(deps.logger, context.get('adminPrincipal'), 'create', parsed.permission.capability_id, parsed.permission.delegatable);
    return answer(context, parsed.permission.capability_id, 201);
  });

  app.post('/permissions/:capability_id', async (context) => {
    const capabilityId = context.req.param('capability_id');
    const existing = await store.find(capabilityId);
    if (!existing) return notFound(context);

    const input = await readFormInput(context.req.raw);
    const parsed = parsePermission(input, { capabilityId, existingPolicyId: existing.delegatable_policy_id });
    if (!parsed.ok) return invalid(context, parsed.errors, { values: input, permission: existing });

    await store.update(parsed.permission);
    audit(deps.logger, context.get('adminPrincipal'), 'update', capabilityId, parsed.permission.delegatable);
    return answer(context, capabilityId, 200);
  });

  app.post('/permissions/:capability_id/delete', async (context) => {
    const capabilityId = context.req.param('capability_id');
    const existing = await store.find(capabilityId);
    if (!existing) return notFound(context);

    try {
      await store.remove(capabilityId);
    } catch (error) {
      if (error instanceof PermissionInUse) {
        return invalid(context, [inUseMessage(error)], { permission: existing, status: 409 });
      }
      throw error;
    }
    audit(deps.logger, context.get('adminPrincipal'), 'delete', capabilityId, false);
    if (wantsJson(context.req.raw)) return context.json({ status: 'deleted', capability_id: capabilityId }, 200);
    return context.redirect(LIST_PATH, 303);
  });

  /**
   * Who holds which permission, for one person (docs 03 §2.1).
   *
   * The subject is a parameter here, which it is nowhere in the screens a person opens
   * for themselves: those read it from the session and only ever show that one person's
   * own records (RULE-56). This is the console an administrator uses to hand somebody a
   * permission, so naming the person is the whole operation.
   */
  app.get('/holders', async (context) => {
    const humanSubject = (context.req.query('human_subject') ?? '').trim();
    if (humanSubject === '') {
      if (wantsJson(context.req.raw)) return context.json({ error: 'invalid_request', details: [MISSING_SUBJECT] }, 400);
      return context.html(holderPage({ humanSubject: '' }));
    }
    const held = await holders.list(humanSubject);
    if (wantsJson(context.req.raw)) return context.json({ human_subject: humanSubject, permissions: held }, 200);
    return context.html(holderPage({ humanSubject, holders: held }));
  });

  /**
   * A grant or a revocation, and the re-evaluation it owes the agents already running.
   *
   * The write and the re-evaluation belong to one handler for the same reason
   * `pnpm perm:set` writes and publishes together: a permission that changed without
   * reaching the agents holding it is a permission the platform believes two things
   * about. A change that moved nothing skips the re-evaluation rather than announcing
   * that a person's permissions narrowed when they did not.
   */
  app.post('/holders', async (context) => {
    const input = await readFormInput(context.req.raw);
    const humanSubject = (input.human_subject ?? '').trim();
    const capabilityId = (input.capability_id ?? '').trim();
    const action = (input.action ?? '').trim();

    const errors = holderErrors(humanSubject, capabilityId, action);
    if (errors.length === 0 && !(await holders.exists(capabilityId))) {
      errors.push(`${capabilityId} は Capability Taxonomy に無い。先に権限を作る。`);
    }
    if (errors.length > 0) {
      if (wantsJson(context.req.raw)) return context.json({ error: 'invalid_request', details: errors }, 400);
      const held = humanSubject === '' ? [] : await holders.list(humanSubject);
      return context.html(holderPage({ humanSubject, holders: held, errors }), 400);
    }

    const changedAt = new Date(deps.reevaluation.clock.now()).toISOString();
    const change = await holders.set(humanSubject, capabilityId, action as PermSetAction, changedAt);
    const reevaluated = change === 'unchanged'
      ? 0
      : await announce(deps, { human_subject: humanSubject, capability_id: capabilityId, action: action as PermSetAction, changed_at: changedAt });

    deps.logger.info('admin.holder_changed', {
      request_id: '', trace_id: '', agent_id: null, human_subject: humanSubject,
    }, {
      action, capability_id: capabilityId, result: change,
      agents_reevaluated: reevaluated, admin_principal: context.get('adminPrincipal'),
    });

    if (wantsJson(context.req.raw)) {
      return context.json({
        human_subject: humanSubject, capability_id: capabilityId, result: change, agents_reevaluated: reevaluated,
      }, 200);
    }
    return context.redirect(`${HOLDER_PATH}?human_subject=${encodeURIComponent(humanSubject)}`, 303);
  });

  return app;
}

const MISSING_SUBJECT = 'human_subject を入力してください';

function holderErrors(humanSubject: string, capabilityId: string, action: string): string[] {
  const errors: string[] = [];
  if (humanSubject === '') errors.push(MISSING_SUBJECT);
  if (capabilityId === '') errors.push('capability_id を入力してください');
  else {
    try {
      assertValidCapabilityId(capabilityId);
    } catch {
      errors.push(`capability_id の形が正しくありません：${capabilityId}`);
    }
  }
  if (!(PERM_SET_ACTIONS as readonly string[]).includes(action)) {
    errors.push(`action は ${PERM_SET_ACTIONS.join(' / ')} のいずれかです`);
  }
  return errors;
}

/**
 * Tells the agents already running that their person's permissions moved.
 *
 * This is the same path a `pnpm perm:set` announcement takes once Pub/Sub has delivered
 * it — the claim, then the re-evaluation — called directly because the console is inside
 * the service that would receive the message. The claim still happens: it keys on
 * `(subject, changed_at)`, so a console change and a delivery describing the same change
 * cannot both re-evaluate.
 */
async function announce(
  deps: AdminPermissionRouteDeps,
  change: { human_subject: string; capability_id: string; action: PermSetAction; changed_at: string },
): Promise<number> {
  const receivedAt = new Date(deps.reevaluation.clock.now()).toISOString();
  if (await claimPermissionChange(deps.reevaluation.store, change, receivedAt) === 'duplicate') return 0;
  return (await reevaluate(change, deps.reevaluation)).length;
}

function inUseMessage(error: PermissionInUse): string {
  const parts: string[] = [];
  if (error.holders > 0) parts.push(`${error.holders}人が保有している`);
  if (error.connector_ids.length > 0) parts.push(`${error.connector_ids.join('、')} へマッピング済みである`);
  return `この権限は削除できない：${parts.join('。')}。先に外してからもう一度実行する。`;
}

/** A form post ends at the list; a script gets the record it just wrote. */
function answer(context: Context<Env>, capabilityId: string, status: 200 | 201): Response {
  if (wantsJson(context.req.raw)) return context.json({ status: 'saved', capability_id: capabilityId }, status);
  return context.redirect(LIST_PATH, 303);
}

function notFound(context: Context<Env>): Response {
  if (wantsJson(context.req.raw)) return context.json({ error: 'not_found' }, 404);
  return context.html(permissionFormPage({ errors: ['その capability_id の権限はない。'] }), 404);
}

function invalid(
  context: Context<Env>,
  errors: string[],
  options: { values?: AdminInput; permission?: PermissionView; status?: 400 | 409 } = {},
): Response {
  const status = options.status ?? 400;
  if (wantsJson(context.req.raw)) {
    return context.json({ error: status === 409 ? 'conflict' : 'invalid_request', details: errors }, status);
  }
  return context.html(permissionFormPage({
    errors,
    ...(options.values ? { values: options.values } : {}),
    ...(options.permission ? { permission: options.permission } : {}),
  }), status);
}

/**
 * One line per change, naming the administrator who made it.
 *
 * The policy data decides what every future agent may hold, so a change to it is
 * evidence in the same sense a decision is: Security Detection reads these lines, and
 * a console that changed the taxonomy silently would leave a platform whose
 * permissions moved with nothing saying who moved them (docs 09 §2).
 */
function audit(logger: Logger, principal: string, action: 'create' | 'update' | 'delete', capabilityId: string, delegatable: boolean): void {
  logger.info('admin.permission_changed', { request_id: '', trace_id: '', agent_id: null, human_subject: null }, {
    action, capability_id: capabilityId, delegatable, admin_principal: principal,
  });
}
