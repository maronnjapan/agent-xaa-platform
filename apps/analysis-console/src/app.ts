import { Hono } from 'hono';
import type { DocumentStore } from '@xaa/gcp';
import type { AnalysisConsoleConfig } from './config.js';
import { createSessionStore, type SessionStore } from './auth/session-store.js';
import { createLoginRoutes } from './auth/login.js';
import { requireUser, type UserVariables } from './auth/require-user.js';
import { readAgentStates, readFindingsFor, readInspectionsFor } from './findings/read.js';
import { FindingsPage, type AgentAnalysis } from './ui/pages/findings.js';
import { renderPage } from './ui/layout.js';
import { CONSOLE_CSS } from './ui/styles/console.js';

export interface AnalysisConsoleDeps {
  config: AnalysisConsoleConfig;
  documents: DocumentStore;
  sessions?: SessionStore;
  verifyIdToken(token: string): Promise<Record<string, unknown>>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The console: one screen, and the login that decides whose screen it is.
 *
 * Its whole job is to show what Security Detection decided about the person's own
 * agents. It writes nothing anyone can read back — its only writes are its own sessions
 * and login transactions — and it calls no other service. There is no API under it
 * either: the screen is rendered whole on the server, so there is nothing for a browser
 * to fetch and nothing to authorise twice.
 *
 * Every route below the login runs behind `requireUser`, which is the only place in this
 * app that answers "who is asking". A handler that resolved that for itself would be a
 * second answer to a question that must only have one (RULE-56).
 */
export function createApp(deps: AnalysisConsoleDeps): Hono<UserVariables> {
  const app = new Hono<UserVariables>();
  const sessions = deps.sessions ?? createSessionStore(deps.documents);
  const now = deps.now ?? (() => Date.now());

  app.get('/livez', (context) => context.json({ status: 'ok', app: 'analysis-console' }));

  app.get('/styles/console.css', (context) =>
    context.body(CONSOLE_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' }));

  app.route('/', createLoginRoutes({
    config: deps.config,
    documents: deps.documents,
    sessions,
    verifyIdToken: deps.verifyIdToken,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    now,
  }));

  app.get('/', requireUser({ sessions, now }), async (context) => {
    const humanSubject = context.get('humanSubject');
    const findings = await readFindingsFor({ documents: deps.documents, humanSubject });
    // Read beside the findings, not instead of them: an agent that behaved leaves no
    // finding at all, and it is the one this screen used to have nothing to say about.
    const inspections = await readInspectionsFor({ documents: deps.documents, humanSubject });
    const agentIds = [...new Set([
      ...findings.map((finding) => finding.agent_id).filter((id): id is string => id !== null),
      ...inspections.map((inspection) => inspection.agent_id),
    ])];
    const states = await readAgentStates({ documents: deps.documents, agentIds, humanSubject });
    const agents: AgentAnalysis[] = agentIds.map((agentId) => ({
      agentId,
      status: states.get(agentId) ?? '',
      findings: findings.filter((finding) => finding.agent_id === agentId),
      inspections: inspections.filter((inspection) => inspection.agent_id === agentId),
    }));
    return context.html(renderPage({
      title: '分析エージェントの判断',
      automationAppUrl: deps.config.automationAppUrl,
      body: FindingsPage({ agents, automationAppUrl: deps.config.automationAppUrl }),
    }));
  });

  return app;
}

export default createApp;
