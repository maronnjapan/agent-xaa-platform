import { Hono, type MiddlewareHandler } from 'hono';
import type { DocumentStore } from '@xaa/gcp';
import type { AutomationAppConfig } from '../config.js';
import { readSessionCookie, type SessionStore } from '../auth/session-store.js';
import { requireUser, type UserVariables } from '../auth/require-user.js';
import { requireAgentOwner, type AgentOwnerVariables } from '../agents/require-owner.js';
import { readAgentStatus } from '../agents/status.js';
import { readTimeline } from '../activity/query.js';
import { readAsset } from './assets.js';
import { Layout, renderDocument } from './layout.js';
import { TimelinePage } from './pages/timeline.js';
import { AgentDetailPage } from './pages/agent-detail.js';
import { WorkDefinitionNewPage } from './pages/work-definition-new.js';

type Env = UserVariables & AgentOwnerVariables;

const STYLES = ['/styles/emphasis.css', '/styles/replay.css'] as const;

export interface PageRouteDeps {
  config: AutomationAppConfig;
  documents: DocumentStore;
  sessions: SessionStore;
  verifyAccessToken(token: string): Promise<Record<string, unknown>>;
  auditWrite?: (line: string) => void;
  now?: () => number;
}

/**
 * The pages a person actually looks at, and the two files they load.
 *
 * They are here rather than in `app.ts` so the screens and the API keep separate route
 * tables, but they run behind the same two guards as the API: `requireUser` decides
 * who is asking, and `requireAgentOwner` decides whose agent is being asked about. A
 * page that resolved either question for itself would be a second answer to a question
 * that must only have one (RULE-56).
 *
 * An unauthenticated request for a page is a redirect to the login flow rather than a
 * 401 body, because the thing on the other end is a browser: a person who followed a
 * link deserves the login screen, not a JSON error.
 */
export function createPageRoutes(deps: PageRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const now = deps.now ?? (() => Date.now());
  const loggedIn = redirectAnonymousToLogin(deps.sessions);
  const asUser = requireUser({
    sessions: deps.sessions, clientId: deps.config.clientId, verifyAccessToken: deps.verifyAccessToken,
  });

  for (const path of ['/timeline.js', '/work-definition.js', '/styles/emphasis.css', '/styles/replay.css']) {
    app.get(path, (context) => {
      const asset = readAsset(path);
      if (!asset) return context.json({ error: 'not_found' }, 404);
      return context.body(asset.body, 200, { 'Content-Type': asset.contentType });
    });
  }

  app.get('/activity', loggedIn, asUser, async (context) => {
    const agentId = context.req.query('agent_id');
    const tasks = await readTimeline({ documents: deps.documents, humanSubject: context.get('humanSubject') });
    // Narrowing by agent is a filter over the person's own timeline, never a widening
    // of it: the subject still comes from the session and nowhere else.
    const shown = agentId ? tasks.filter((task) => task.agent_id === agentId) : tasks;
    return context.html(await renderDocument(
      <Layout title="アクティビティ" styles={STYLES} script="/timeline.js">
        <TimelinePage tasks={shown} />
      </Layout>,
    ));
  });

  app.get('/agents/:agent_id', loggedIn, asUser, requireAgentOwner({
    documents: deps.documents, ...(deps.auditWrite ? { write: deps.auditWrite } : {}), now,
  }), async (context) => {
    const agentId = context.get('agentId');
    const status = await readAgentStatus({ documents: deps.documents, agentId, now: now() });
    return context.html(await renderDocument(
      <Layout title="Agent の状況" styles={STYLES}>
        <AgentDetailPage agentId={agentId} status={status} />
      </Layout>,
    ));
  });

  app.get('/work-definitions/new', loggedIn, asUser, async (context) =>
    context.html(await renderDocument(
      <Layout title="新しい作業を定義する" styles={STYLES} script="/work-definition.js">
        <WorkDefinitionNewPage defaultHours={deps.config.defaultAgentLifetimeHours} />
      </Layout>,
    )));

  return app;
}

function redirectAnonymousToLogin(sessions: SessionStore): MiddlewareHandler<Env> {
  return async (context, next) => {
    const sessionId = readSessionCookie(context.req.header('cookie'));
    if (!sessionId || !await sessions.find(sessionId)) return context.redirect('/login', 302);
    await next();
    return undefined;
  };
}
