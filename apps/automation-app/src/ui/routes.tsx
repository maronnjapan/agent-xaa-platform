import { readAnalysisRuns } from '../security/query.js';
import { readFaultTrials } from '../agents/faults.js';
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
import { readAsset, STATIC_ASSETS } from './assets.js';
import { activityViewOf, AGENT_KEY, EVENT_KEY, RUN_KEY, TASK_KEY, VIEW_KEY, type ActivityFocus } from './activity-links.js';
import { renderPage } from './layout.js';
import type { HomeAgent, HomeTodoItem, TodoAgentView } from './pages/home.js';

type Env = UserVariables & AgentOwnerVariables;

const STYLES = ['/styles/app.css', '/styles/emphasis.css', '/styles/replay.css'] as const;

/**
 * One bundle for every screen (DEC-APP-06, revised).
 *
 * The four screens are one React application, and four bundles would each carry their
 * own copy of the framework. Which screen it renders comes from the value the server
 * wrote into the document, not from the script's name — so a page still runs only its
 * own code.
 */
const SCRIPT = '/app.js';

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
 * The pages a person actually looks at, and the files they load.
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

  for (const path of Object.keys(STATIC_ASSETS)) {
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
   * browser remembers: the ToDos, their state, the permissions that were presented and
   * whether they were approved, and what the agent carrying each one is doing. Each of
   * the person's own records is fetched by their own subject, taken from the session
   * and from nowhere else (RULE-56).
   *
   * An agent is read only for a ToDo that names it, and a ToDo names an agent only
   * because this app wrote the id there when provisioning answered for this person. The
   * checkpoint is read through the same reader the agent's own screen uses
   * (T-APP-27), and the verdict comes off the person's own timeline.
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
    const items: HomeTodoItem[] = await Promise.all(definitions.map(async (definition) => ({
      definition,
      agentDefinition: presented.find((candidate) => candidate.work_definition_id === definition.work_definition_id),
      ...(definition.agent_id === null ? {} : { agent: await agentViewOf(definition.agent_id, tasks) }),
    })));
    return context.html(renderPage({
      analysisConsoleUrl: deps.config.analysisConsoleUrl,
      title: 'ToDo',
      styles: STYLES,
      script: SCRIPT,
      data: {
        page: 'home',
        defaultMinutes: deps.config.defaultAgentLifetimeMinutes,
        items,
        agents: agentsOf(tasks),
        defaultFrom: isoDate(now() - SUGGESTION_WINDOW_DAYS * 86_400_000),
        defaultTo: isoDate(now()),
        today: isoDate(now()),
      },
    }));
  });

  /**
   * How to work the screens, on the screens.
   *
   * It reads nothing and takes no parameter, so it is the one page whose output does
   * not depend on who is asking. It still runs behind the same guard as the others:
   * every step it describes is a button on a screen that requires a session, and a
   * guide readable by someone who cannot reach any of them would only mislead.
   */
  app.get('/guide', asUser, (context) =>
    context.html(renderPage({ analysisConsoleUrl: deps.config.analysisConsoleUrl, title: '使い方', styles: STYLES, script: SCRIPT, data: { page: 'guide' } })));

  app.get('/security', asUser, async (context) => context.html(renderPage({
    title: 'ログ分析モニター', analysisConsoleUrl: deps.config.analysisConsoleUrl, styles: STYLES, script: SCRIPT,
    data: { page: 'security', runs: await readAnalysisRuns(deps.documents, context.get('humanSubject')), now: now() },
  })));

  /**
   * The activity screen: the list, or one agent in the viewer.
   *
   * Which face is served is read off the address (`activity-links.ts`), so a link to
   * the account of one task is a page the server renders in full — the viewer is not a
   * panel the browser builds after the fact. Narrowing by agent, and opening one run,
   * are both filters over the person's own timeline, never a widening of it: the
   * subject still comes from the session and nowhere else. A `run` that names nothing
   * of the person's is not an error and not someone else's; it is the list.
   */
  app.get('/activity', asUser, async (context) => {
    const agentId = context.req.query(AGENT_KEY);
    const runId = context.req.query(RUN_KEY);
    const tasks = await readTimeline({ documents: deps.documents, humanSubject: context.get('humanSubject') });
    const narrowed = agentId ? tasks.filter((task) => task.agent_id === agentId) : tasks;
    const focused = runId ? narrowed.filter((task) => task.run_id === runId) : [];
    const focus: ActivityFocus | null = runId && focused.length > 0
      ? {
        runId,
        taskId: context.req.query(TASK_KEY) ?? null,
        view: activityViewOf(context.req.query(VIEW_KEY)),
        eventId: context.req.query(EVENT_KEY) ?? null,
      }
      : null;
    return context.html(renderPage({
      analysisConsoleUrl: deps.config.analysisConsoleUrl,
      title: 'アクティビティ', styles: STYLES, script: SCRIPT,
      data: { page: 'timeline', tasks: focus === null ? narrowed : focused, agentId: agentId ?? null, focus },
    }));
  });

  app.get('/agents/:agent_id', asUser, requireAgentOwner({
    documents: deps.documents, ...(deps.auditWrite ? { write: deps.auditWrite } : {}), now,
  }), async (context) => {
    const agentId = context.get('agentId');
    const status = await readAgentStatus({ documents: deps.documents, agentId, now: now() });
    return context.html(renderPage({
      analysisConsoleUrl: deps.config.analysisConsoleUrl,
      title: 'Agent の状況', styles: STYLES, script: SCRIPT, data: { page: 'agent-detail', agentId, status, faultInjectionEnabled: deps.config.faultInjectionEnabled === true,
        faultTrials: deps.config.faultInjectionEnabled ? await readFaultTrials(deps.documents, agentId, now()) : [] },
    }));
  });

  app.get('/todos/new', asUser, (context) =>
    context.html(renderPage({
      analysisConsoleUrl: deps.config.analysisConsoleUrl,
      title: '新しい ToDo を書く',
      styles: STYLES,
      script: SCRIPT,
      data: { page: 'todo-new', defaultMinutes: deps.config.defaultAgentLifetimeMinutes },
    })));

  return app;

  /**
   * The agent carrying a ToDo, as the card shows it.
   *
   * The snapshot is the checkpoint; the verdict is the Runtime's own terminal event on
   * the agent's task — `TASK_COMPLETED`, `TASK_BLOCKED` or `TASK_FAILED`, read off the
   * event as the Runtime named it. A task that has not ended has no verdict yet, and
   * the card says so rather than guessing (RULE-59).
   */
  async function agentViewOf(agentId: string, tasks: readonly TimelineTask[]): Promise<TodoAgentView> {
    const status = await readAgentStatus({ documents: deps.documents, agentId, now: now() });
    const finished = tasks.find((task) =>
      task.agent_id === agentId && task.status === 'completed' && task.task_id.startsWith('task-'));
    const verdict = finished?.status === 'completed'
      ? finished.events
        .map((event) => (event.detail as { event_type?: unknown } | undefined)?.event_type)
        .find((type): type is string => typeof type === 'string' && type.startsWith('TASK_'))
      : undefined;
    return {
      agentId,
      status: status.agent_status,
      remainingSeconds: status.remaining_seconds,
      outcome: finished?.status === 'completed' ? verdict ?? finished.terminal_outcome : null,
      completedAt: finished?.status === 'completed' ? finished.completed_at : null,
    };
  }
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
