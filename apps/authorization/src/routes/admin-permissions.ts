import { Hono, type Context } from 'hono';
import type { AdminConsoleVariables } from '@xaa/control-plane-auth';
import type { Logger } from '@xaa/logging';
import type { DocumentStore } from '@xaa/gcp';
import { parsePermission, type PermissionInput } from '../admin/permission.js';
import {
  createPermissionAdminStore, PermissionExists, PermissionInUse,
  type PermissionAdminStore, type PermissionView,
} from '../admin/permission-store.js';
import { permissionFormPage, permissionListPage } from '../admin/pages.js';

export interface AdminPermissionRouteDeps {
  documents: DocumentStore;
  logger: Logger;
  store?: PermissionAdminStore;
}

type Env = AdminConsoleVariables;

const LIST_PATH = '/admin/permissions';

/**
 * The permission screens (docs 03 §2).
 *
 * The Capability Taxonomy is the unit every permission in this platform is expressed
 * in — Human Permission, Delegatable Permission, Organization Policy and the decisions
 * themselves — so this is where a permission is created, changed and retired.
 *
 * Every route answers a browser or a script from the same handler: a form post gets a
 * redirect back to the list, `Accept: application/json` gets the record. Two route
 * tables for one operation is how a console and its API drift into disagreeing about
 * what a permission is.
 */
export function createAdminPermissionRoutes(deps: AdminPermissionRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const store = deps.store ?? createPermissionAdminStore(deps.documents);

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

  app.post('/permissions', async (context) => {
    const input = await readInput(context.req.raw);
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

    const input = await readInput(context.req.raw);
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

  return app;
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
  options: { values?: PermissionInput; permission?: PermissionView; status?: 400 | 409 } = {},
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
 * Whether the caller wants JSON.
 *
 * A browser's form post announces `text/html` and gets a redirect; `curl` sending or
 * asking for JSON gets JSON. Nothing about authorisation depends on this — it decides
 * the shape of an answer the caller has already been allowed to have.
 */
function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return false;
  return accept.includes('application/json') || (request.headers.get('content-type') ?? '').includes('application/json');
}

/** The form fields, from either encoding, as plain strings. */
async function readInput(request: Request): Promise<PermissionInput> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await request.clone().json().catch(() => ({})) as Record<string, unknown>;
    const input: PermissionInput = {};
    for (const [key, value] of Object.entries(body)) {
      input[key] = typeof value === 'boolean' ? (value ? 'on' : '') : value === undefined || value === null ? undefined : String(value);
    }
    return input;
  }
  const form = await request.clone().formData().catch(() => new FormData());
  const input: PermissionInput = {};
  form.forEach((value, key) => { input[key] = typeof value === 'string' ? value : undefined; });
  return input;
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
