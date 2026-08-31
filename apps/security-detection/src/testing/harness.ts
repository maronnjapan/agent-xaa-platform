import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { CAPABILITIES, TOOL_IDS } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import type { LogEntry } from '@xaa/logging';
import createApp, { type SecurityDetectionDeps } from '../index.js';
import type { AgentBaseline } from '../baseline/types.js';
import { buildBaseline } from '../baseline/build.js';
import type { TransitionRequest } from '../response/dispatch.js';

export const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
export const OTHER_AGENT_ID = 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz';
export const FINANCE_RESOURCE = 'https://resource-finance-api.test';

export interface SecurityHarness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  documents: DocumentStore;
  transitions: TransitionRequest[];
  logs: string[];
  aiCalls: number;
}

export function createSecurityHarness(options: {
  aiOutput?: string | null;
  now?: () => number;
} = {}): SecurityHarness {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'security-detection');
  const transitions: TransitionRequest[] = [];
  const logs: string[] = [];
  const state = { aiCalls: 0 };

  const deps: SecurityDetectionDeps = {
    documents,
    sendToLifecycle: async (request) => { transitions.push(request); return new Response(null, { status: 202 }); },
    analyze: async () => { state.aiCalls += 1; return options.aiOutput ?? null; },
    logger: createLogger('security-detection', 'agent_op', (line) => logs.push(line)),
    ...(options.now ? { now: options.now } : {}),
    financeResourceUrl: FINANCE_RESOURCE,
  };

  const app = createApp(deps);
  return {
    documents, transitions, logs,
    get aiCalls() { return state.aiCalls; },
    fetch: async (path, init) => app.fetch(new Request(new URL(path, 'https://security-detection.test'), init)),
  };
}

/** A log line exactly as the shared logger writes one. */
export function logEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    severity: 'INFO',
    app: 'agent-op',
    log_source: 'agent_op',
    event: 'token_exchange',
    request_id: 'req-1',
    trace_id: 'trace-1',
    agent_id: AGENT_ID,
    human_subject: 'testuser',
    timestamp: '2026-01-01T12:00:00.000Z',
    fields: {},
    ...overrides,
  };
}

/** Names come from the shared identifier table, so a rename reaches the fixture too. */
export const DOCUMENT_READ = CAPABILITIES.find((capability) => capability.startsWith('document.'))!;
export const DOCUMENT_TOOLS = TOOL_IDS.filter((tool) => tool.startsWith('internal.document.')).slice(0, 2);

export function baselineFor(overrides: Partial<Parameters<typeof buildBaseline>[0]> = {}): AgentBaseline {
  return buildBaseline({
    effectiveCapabilities: [DOCUMENT_READ],
    expectedTools: [...DOCUMENT_TOOLS],
    expectedResources: ['https://resource-docs-api.test'],
    expiresAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });
}
