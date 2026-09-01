import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { CAPABILITIES, TOOL_IDS, type ActivityEvent } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import type { LogEntry } from '@xaa/logging';
import { createSecurityDetection, type DetectionRun, type SecurityDetectionDeps } from '../index.js';
import type { AgentBaseline } from '../baseline/types.js';
import { buildBaseline } from '../baseline/build.js';
import type { TransitionRequest } from '../response/dispatch.js';

export const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
export const OTHER_AGENT_ID = 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz';
export const FINANCE_RESOURCE = 'https://resource-finance-api.test';
/** The bearer the harness's caller checks accept; anything else is refused, as in production. */
export const CALLER_TOKEN = 'good';

export interface SecurityHarness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The ingestion run the pull loop and the push route both call. */
  runOnce: DetectionRun;
  documents: DocumentStore;
  /** The same Firestore seen as the Provisioner, which is what writes a baseline. */
  seedStore: DocumentStore;
  transitions: TransitionRequest[];
  logs: string[];
  activity: ActivityEvent[];
  aiCalls: number;
}

export function createSecurityHarness(options: {
  aiOutput?: string | null;
  now?: () => number;
  maxLifetimeSeconds?: number;
  /** Present only when the test exercises the push route, as in production. */
  callerVerify?(token: string): Promise<string | null>;
  /** Defaults to a configured check, so the review route is reachable but never open. */
  reviewerVerify?(token: string): Promise<string | null>;
  /** What the Lifecycle Manager answers. Anything but 2xx is a refused transition. */
  transitionStatus?: number;
} = {}): SecurityHarness {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'security-detection');
  const seedStore = createFirestoreDocumentStore(firestore, 'provisioner');
  const transitions: TransitionRequest[] = [];
  const logs: string[] = [];
  const activity: ActivityEvent[] = [];
  const state = { aiCalls: 0 };

  const deps: SecurityDetectionDeps = {
    documents,
    sendToLifecycle: async (request) => {
      transitions.push(request);
      return new Response(null, { status: options.transitionStatus ?? 202 });
    },
    analyze: async () => { state.aiCalls += 1; return options.aiOutput ?? null; },
    logger: createLogger('security-detection', 'agent_op', (line) => logs.push(line)),
    publishActivity: async (event) => { activity.push(event); },
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxLifetimeSeconds ? { maxLifetimeSeconds: options.maxLifetimeSeconds } : {}),
    ...(options.callerVerify ? { callerVerify: options.callerVerify } : {}),
    reviewerVerify: options.reviewerVerify
      ?? (async (token: string) => (token === CALLER_TOKEN ? 'sa-security@test' : null)),
    financeResourceUrl: FINANCE_RESOURCE,
  };

  const { app, runOnce } = createSecurityDetection(deps);
  return {
    documents, seedStore, transitions, logs, activity, runOnce,
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
