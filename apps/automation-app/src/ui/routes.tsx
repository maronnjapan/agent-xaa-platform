import { Hono, type MiddlewareHandler } from 'hono';
import type { DocumentStore } from '@xaa/gcp';
import type { AutomationAppConfig } from '../config.js';
import type { SessionStore } from '../auth/session-store.js';
import { requireUser, type UserVariables } from '../auth/require-user.js';
import { requireAgentOwner, type AgentOwnerVariables } from '../agents/require-owner.js';
import { readAgentStatus } from '../agents/status.js';
import { readTimeline, type TimelineTask } from '../activity/query.js';
import { createWorkDefinitionStore } from '../work-definition/store.js';
import { createAgentDefinitionStore } from '../agent-definition/approval.js';
import { readAsset } from './assets.js';
import { Layout, renderDocument } from './layout.js';
import { GuidePage } from './pages/guide.js';
import { HomePage, type HomeAgent, type HomeWorkItem } from './pages/home.js';
import { TimelinePage } from './pages/timeline.js';
import { AgentDetailPage } from './pages/agent-detail.js';
import { WorkDefinitionNewPage } from './pages/work-definition-new.js';

type Env = UserVariables & AgentOwnerVariables;

const STYLES = ['/styles/app.css', '/styles/emphasis.css', '/styles/replay.css'] as const;

/** How far back the suggestion form looks by default. */
const SUGGESTION_WINDOW_DAYS = 7;

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
 * link deserves the login screen, not a JSON error. That is the only difference from
 * the API's guard — the same `requireUser` decides, and only the shape of its refusal
 * is translated.
 */
export function createPageRoutes(deps: PageRouteDeps): Hono<Env> {
  const app = new Hono<Env>();
  const now = deps.now ?? (() => Date.now());
  const asUser = asPerson({
    sessions: deps.sessions, clientId: deps.config.clientId, verifyAccessToken: deps.verifyAccessToken,
  });

  const workDefinitions = createWorkDefinitionStore(deps.documents);
  const agentDefinitions = createAgentDefinitionStore(deps.documents);

  for (const path of [
    '/agent-detail.js', '/home.js', '/timeline.js', '/work-definition.js',
    '/styles/app.css', '/styles/emphasis.css', '/styles/replay.css',
  ]) {
    app.get(path, (context) => {
      const asset = readAsset(path);
      if (!asset) return context.json({ error: 'not_found' }, 404);
      return context.body(asset.body, 200, { 'Content-Type': asset.contentType });
    });
  }

  /**
   * Where a person lands after logging in, and where the whole flow happens.
   *
   * The page is rendered from what the server holds rather than from anything the
   * browser remembers: the drafts, their state, the permissions that were presented and
   * whether they were approved. Each of the person's own records is fetched by their own
   * subject, taken from the session and from nowhere else (RULE-56).
   */
  app.get('/', asUser, async (context) => {
    const humanSubject = context.get('humanSubject');
    const [definitions, presented, tasks] = await Promise.all([
      workDefinitions.listByHuman(humanSubject),
      agentDefinitions.listByHuman(humanSubject),
      readTimeline({ documents: deps.documents, humanSubject }),
    ]);
    // Newest first, so a second attempt at the same work shows the permissions that were
    // presented last rather than the ones that have been superseded.
    const items: HomeWorkItem[] = definitions.map((definition) => ({
      definition,
      agentDefinition: presented.find((candidate) => candidate.work_definition_id === definition.work_definition_id),
    }));
    return context.html(await renderDocument(
      <Layout title="自動化をつくる" styles={STYLES} script="/home.js">
        <HomePage
          defaultMinutes={deps.config.defaultAgentLifetimeMinutes}
          items={items}
          agents={agentsOf(tasks)}
          defaultFrom={isoDate(now() - SUGGESTION_WINDOW_DAYS * 86_400_000)}
          defaultTo={isoDate(now())}
        />
      </Layout>,
    ));
  });

  /**
   * How to work the screens, on the screens.
   *
   * It reads nothing and takes no parameter, so it is the one page whose output does
   * not depend on who is asking. It still runs behind the same guard as the others:
   * every step it describes is a button on a screen that requires a session, and a
   * guide readable by someone who cannot reach any of them would only mislead.
   */
  app.get('/guide', asUser, async (context) =>
    context.html(await renderDocument(
      <Layout title="使い方" styles={STYLES}>
        <GuidePage />
      </Layout>,
    )));

  app.get('/activity', asUser, async (context) => {
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

  app.get('/agents/:agent_id', asUser, requireAgentOwner({
    documents: deps.documents, ...(deps.auditWrite ? { write: deps.auditWrite } : {}), now,
  }), async (context) => {
    const agentId = context.get('agentId');
    const status = await readAgentStatus({ documents: deps.documents, agentId, now: now() });
    return context.html(await renderDocument(
      <Layout title="Agent の状況" styles={STYLES} script="/agent-detail.js">
        <AgentDetailPage agentId={agentId} status={status} />
      </Layout>,
    ));
  });

  app.get('/work-definitions/new', asUser, async (context) =>
    context.html(await renderDocument(
      <Layout title="新しい作業を定義する" styles={STYLES} script="/work-definition.js">
        <WorkDefinitionNewPage defaultMinutes={deps.config.defaultAgentLifetimeMinutes} />
      </Layout>,
    )));

  return app;
}

/**
 * The agents a person has, read off their own timeline.
 *
 * There is no query for "this person's agents": the registrations belong to the
 * Provisioner and this app may read one only by id (DEV-05). What it does have is the
 * events those agents produced on the person's own timeline, and the first mention of
 * each agent carries the work it was created for.
 */
function agentsOf(tasks: readonly TimelineTask[]): HomeAgent[] {
  const byAgent = new Map<string, string>();
  for (const task of tasks) {
    if (task.agent_id === null) continue;
    if (!byAgent.has(task.agent_id)) byAgent.set(task.agent_id, task.purpose);
  }
  return [...byAgent].map(([agentId, purpose]) => ({ agentId, purpose }));
}

function isoDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * The API's guard, with its refusal translated for a browser.
 *
 * Every reason `requireUser` has for saying no — no cookie, an unknown session, an
 * expired or wrong-audience token — ends at the login screen, because from the far side
 * of the screen they are the same situation: the person has to log in again. Nothing
 * about who is asking is decided here; that answer still has exactly one source.
 */
function asPerson(options: {
  sessions: SessionStore;
  clientId: string;
  verifyAccessToken(token: string): Promise<Record<string, unknown>>;
}): MiddlewareHandler<UserVariables> {
  const guard = requireUser(options);
  return async (context, next) => {
    const refusal = await guard(context, next);
    if (refusal && refusal.status === 401) return context.redirect('/login', 302);
    return refusal;
  };
}
