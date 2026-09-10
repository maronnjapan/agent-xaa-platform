import { Hono, type Context } from 'hono';
import { readFormInput, wantsJson } from '@xaa/admin-ui';
import type { AdminConsoleVariables } from '@xaa/control-plane-auth';
import type { Logger } from '@xaa/logging';
import { parseDocumentCreate, parseDocumentPatch } from '../admin/document-input.js';
import { documentDeletePage, documentFormPage, documentListPage } from '../admin/pages.js';
import { VersionConflict, type createDocumentRepository } from '../store/documents.js';

type Env = AdminConsoleVariables;

const LIST_PATH = '/admin/documents';
const LIST_LIMIT = 100;

/** Routes carry their operation name statically; it is never derived from the path. */
export const ADMIN_DOCUMENT_OPERATIONS = {
  list: 'admin.document.list', get: 'admin.document.get', create: 'admin.document.create',
  update: 'admin.document.update', delete: 'admin.document.delete',
} as const;

/** Every console route, declared once so the reachable surface is one screen long. */
export const ADMIN_DOCUMENT_ROUTES = [
  { method: 'GET', path: '/admin' },
  { method: 'GET', path: '/admin/console.css' },
  { method: 'GET', path: '/admin/documents' },
  { method: 'GET', path: '/admin/documents/new' },
  { method: 'GET', path: '/admin/documents/:document_id' },
  { method: 'GET', path: '/admin/documents/:document_id/delete' },
  { method: 'POST', path: '/admin/documents' },
  { method: 'POST', path: '/admin/documents/:document_id' },
  { method: 'POST', path: '/admin/documents/:document_id/delete' },
] as const;

export interface AdminDocumentRouteDeps {
  repository: ReturnType<typeof createDocumentRepository>;
  logger: Logger;
}

/**
 * The document screens (docs 04 §2.1).
 *
 * They edit the same rows the XAA-protected API serves, through the same repository, so
 * a document written here is a document an agent reads — there is no second store and no
 * second shape. What differs is who is asking and what they may do: the API answers an
 * agent carrying a delegated, DPoP-bound Access Token and offers no DELETE; this console
 * answers an administrator's Google identity token and does.
 *
 * Every screen is scoped to one owner, taken from the request and written into every
 * read and every write. It is a parameter here because naming the person is the whole
 * operation — which is exactly why it may never be one on a screen a person opens for
 * themselves (RULE-56).
 */
export function createAdminDocumentRoutes(deps: AdminDocumentRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const repository = deps.repository;

  app.get('/', (context) => context.redirect(LIST_PATH, 302));

  app.get('/documents', async (context) => {
    const ownerSubject = owner(context);
    if (ownerSubject === '') return noOwner(context);
    const type = (context.req.query('type') ?? '').trim();
    const documents = await repository.list({
      ownerSubject, limit: LIST_LIMIT, ...(type === '' ? {} : { type }),
    });
    if (wantsJson(context.req.raw)) return context.json({ owner_subject: ownerSubject, documents }, 200);
    return context.html(documentListPage({ ownerSubject, documents, ...(type === '' ? {} : { type }) }));
  });

  // Registered before `/documents/:document_id`, which would otherwise read `new` as an
  // id and answer 404 for the page that creates one.
  app.get('/documents/new', (context) => {
    const ownerSubject = owner(context);
    if (ownerSubject === '') return noOwner(context);
    return context.html(documentFormPage({ ownerSubject }));
  });

  app.get('/documents/:document_id', async (context) => {
    const ownerSubject = owner(context);
    if (ownerSubject === '') return noOwner(context);
    const document = await repository.get(context.req.param('document_id'), ownerSubject);
    if (!document) return notFound(context, ownerSubject);
    if (wantsJson(context.req.raw)) return context.json(document, 200);
    return context.html(documentFormPage({ ownerSubject, document }));
  });

  /**
   * The question before a deletion. It is a GET because it changes nothing: a person who
   * arrives here by following a link, or by reloading, has not deleted anything yet.
   */
  app.get('/documents/:document_id/delete', async (context) => {
    const ownerSubject = owner(context);
    if (ownerSubject === '') return noOwner(context);
    const document = await repository.get(context.req.param('document_id'), ownerSubject);
    if (!document) return notFound(context, ownerSubject);
    return context.html(documentDeletePage({ ownerSubject, document }));
  });

  app.post('/documents', async (context) => {
    const input = await readFormInput(context.req.raw);
    const parsed = parseDocumentCreate(input);
    if (!parsed.ok) {
      return invalid(context, parsed.errors, { ownerSubject: (input.owner_subject ?? '').trim(), values: input });
    }
    const documentId = await repository.create(parsed.value);
    audit(deps.logger, context, 'create', documentId, parsed.value.ownerSubject);
    if (wantsJson(context.req.raw)) return context.json({ document_id: documentId }, 201);
    return context.redirect(listUrl(parsed.value.ownerSubject), 303);
  });

  app.post('/documents/:document_id', async (context) => {
    const documentId = context.req.param('document_id');
    const input = await readFormInput(context.req.raw);
    const ownerSubject = (input.owner_subject ?? '').trim();
    if (ownerSubject === '') return noOwner(context, 400);

    const parsed = parseDocumentPatch(input);
    if (!parsed.ok) {
      const current = await repository.get(documentId, ownerSubject);
      if (!current) return notFound(context, ownerSubject);
      return invalid(context, parsed.errors, { ownerSubject, values: input, document: current });
    }

    try {
      const updated = await repository.update(documentId, ownerSubject, parsed.value);
      if (!updated) return notFound(context, ownerSubject);
      audit(deps.logger, context, 'update', documentId, ownerSubject);
      if (wantsJson(context.req.raw)) {
        return context.json({ document_id: updated.document_id, version: updated.version, updated_at: updated.updated_at }, 200);
      }
      return context.redirect(listUrl(ownerSubject), 303);
    } catch (error) {
      if (!(error instanceof VersionConflict)) throw error;
      // Somebody else wrote while this form was open. The screen says so and shows what
      // is stored now, rather than offering to overwrite it with what was typed against
      // a version that no longer exists.
      const current = await repository.get(documentId, ownerSubject);
      if (!current) return notFound(context, ownerSubject);
      return invalid(context, ['このドキュメントは開いてから更新された。いまの内容を確かめてから、もう一度保存する。'], {
        ownerSubject, document: current, status: 409,
      });
    }
  });

  app.post('/documents/:document_id/delete', async (context) => {
    const documentId = context.req.param('document_id');
    const input = await readFormInput(context.req.raw);
    const ownerSubject = (input.owner_subject ?? '').trim();
    if (ownerSubject === '') return noOwner(context, 400);

    if (!await repository.remove(documentId, ownerSubject)) return notFound(context, ownerSubject);
    audit(deps.logger, context, 'delete', documentId, ownerSubject);
    if (wantsJson(context.req.raw)) return context.json({ status: 'deleted', document_id: documentId }, 200);
    return context.redirect(listUrl(ownerSubject), 303);
  });

  return app;
}

const MISSING_OWNER = 'owner_subject を入力してください';

function owner(context: Context<Env>): string {
  return (context.req.query('owner_subject') ?? '').trim();
}

function listUrl(ownerSubject: string): string {
  return `${LIST_PATH}?owner_subject=${encodeURIComponent(ownerSubject)}`;
}

/**
 * The screens all need to know whose documents they are about.
 *
 * On a GET that is a question rather than a failure — nobody has said who yet, and the
 * list page is where they say it. On a write it is a request that cannot be carried out,
 * so the same page is served with a status that says so: every form carries the owner in
 * a hidden field, and one that arrives without it did not come from a screen.
 */
function noOwner(context: Context<Env>, status: 200 | 400 = 200): Response {
  if (wantsJson(context.req.raw)) return context.json({ error: 'invalid_request', details: [MISSING_OWNER] }, 400);
  return context.html(documentListPage({
    ownerSubject: '', ...(status === 200 ? {} : { errors: [MISSING_OWNER] }),
  }), status);
}

/** Another owner's document is 404, not 403: a 403 would confirm it exists. */
function notFound(context: Context<Env>, ownerSubject: string): Response {
  if (wantsJson(context.req.raw)) return context.json({ error: 'not_found' }, 404);
  return context.html(documentListPage({
    ownerSubject, documents: [], errors: ['そのドキュメントは、この owner_subject のものとしては無い。'],
  }), 404);
}

function invalid(
  context: Context<Env>,
  errors: string[],
  options: {
    ownerSubject: string;
    values?: Record<string, string | undefined>;
    document?: Awaited<ReturnType<ReturnType<typeof createDocumentRepository>['get']>>;
    status?: 400 | 409;
  },
): Response {
  const status = options.status ?? 400;
  if (wantsJson(context.req.raw)) {
    return context.json({ error: status === 409 ? 'version_conflict' : 'invalid_request', details: errors }, status);
  }
  return context.html(documentFormPage({
    ownerSubject: options.ownerSubject,
    errors,
    ...(options.values ? { values: options.values } : {}),
    ...(options.document ? { document: options.document } : {}),
  }), status);
}

/**
 * One line per change, naming the administrator who made it and whose document moved.
 *
 * The API's own access log records every agent that touched a document; a console that
 * wrote silently would leave the one caller who can delete a document as the one caller
 * nothing records.
 */
function audit(
  logger: Logger,
  context: Context<Env>,
  action: 'create' | 'update' | 'delete',
  documentId: string,
  ownerSubject: string,
): void {
  logger.info('admin.document_changed', {
    request_id: '',
    trace_id: context.req.header('X-Cloud-Trace-Context')?.split('/')[0] ?? '',
    agent_id: null,
    human_subject: ownerSubject,
  }, {
    action,
    operation: ADMIN_DOCUMENT_OPERATIONS[action],
    document_id: documentId,
    admin_principal: context.get('adminPrincipal'),
  });
}
