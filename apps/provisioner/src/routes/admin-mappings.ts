import { Hono, type Context } from 'hono';
import type { AdminConsoleVariables } from '@xaa/control-plane-auth';
import type { DocumentStore } from '@xaa/gcp';
import type { Logger } from '@xaa/logging';
import { createMappingStore, type MappingChange, type MappingStore } from '../admin/mapping-store.js';
import { mappingPage } from '../admin/pages.js';

export interface AdminMappingRouteDeps {
  documents: DocumentStore;
  logger: Logger;
  store?: MappingStore;
}

type Env = AdminConsoleVariables;

/**
 * The screen that maps a permission to the resource that executes it (docs 04 §5).
 *
 * The catalogue is the Provisioner's to hold, so it is the Provisioner's to edit.
 * Automation App is deliberately not where this lives: it may hold no capability, no
 * resource list and no permission information at all (RULE-07), and a mapping screen
 * is all three.
 */
export function createAdminMappingRoutes(deps: AdminMappingRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const store = deps.store ?? createMappingStore(deps.documents);

  app.get('/', (context) => context.redirect('/admin/mappings', 302));

  app.get('/mappings', async (context) => {
    const overview = await store.overview();
    if (wantsJson(context.req.raw)) return context.json(overview, 200);
    return context.html(mappingPage(overview));
  });

  app.post('/mappings', async (context) => {
    const mappings = await readMappings(context.req.raw);
    if (Object.keys(mappings).length === 0) return respond(context, store, ['変更する対応付けが1件も送られていない。'], 400);

    const result = await store.apply(mappings);
    if (!result.ok) {
      const errors = [
        ...result.unknownTools.map((toolId) => `${toolId} という操作はカタログにない。`),
        ...result.unknownCapabilities.map((capability) => `${capability} という権限は定義されていない。先に Authorization Platform で作る。`),
      ];
      return respond(context, store, errors, 400);
    }

    for (const change of result.changes) audit(deps.logger, context.get('adminPrincipal'), change);
    if (wantsJson(context.req.raw)) return context.json({ status: 'saved', changes: result.changes }, 200);
    return context.html(mappingPage(await store.overview(), { saved: savedLines(result.changes) }));
  });

  return app;
}

async function respond(context: Context<Env>, store: MappingStore, errors: string[], status: 400): Promise<Response> {
  if (wantsJson(context.req.raw)) return context.json({ error: 'invalid_request', details: errors }, status);
  return context.html(mappingPage(await store.overview(), { errors }), status);
}

function savedLines(changes: readonly MappingChange[]): string[] {
  if (changes.length === 0) return ['変更はなかった。'];
  return changes.map((change) => `${change.tool_id}：${change.from} → ${change.to}`);
}

/**
 * The submitted mapping, from either encoding.
 *
 * A form names each select after the tool it belongs to; a script sends the same pairs
 * under `mappings`. Nothing else in the body is read, so a field the screen does not
 * own cannot become a write.
 */
async function readMappings(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  const mappings: Record<string, string> = {};
  if (contentType.includes('application/json')) {
    const body = await request.clone().json().catch(() => ({})) as { mappings?: Record<string, unknown> };
    for (const [toolId, capability] of Object.entries(body.mappings ?? {})) {
      if (typeof capability === 'string') mappings[toolId] = capability;
    }
    return mappings;
  }
  const form = await request.clone().formData().catch(() => new FormData());
  form.forEach((value, key) => { if (typeof value === 'string' && value !== '') mappings[key] = value; });
  return mappings;
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return false;
  return accept.includes('application/json') || (request.headers.get('content-type') ?? '').includes('application/json');
}

/**
 * One line per mapping that actually moved, naming the administrator who moved it.
 *
 * A mapping decides which API a granted capability reaches, so a change to it is the
 * same kind of evidence as a policy decision: without this line, an agent provisioned
 * tomorrow would reach a resource nothing recorded anyone connecting it to.
 */
function audit(logger: Logger, principal: string, change: MappingChange): void {
  logger.info('admin.mapping_changed', { request_id: '', trace_id: '', agent_id: null, human_subject: null }, {
    tool_id: change.tool_id,
    from_capability: change.from,
    to_capability: change.to,
    admin_principal: principal,
  });
}
