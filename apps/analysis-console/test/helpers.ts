import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import createApp from '../src/app.js';
import type { AnalysisConsoleConfig } from '../src/config.js';
import { createSessionStore } from '../src/auth/session-store.js';

export const SUBJECT = 'testuser';
export const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
export const OTHER_AGENT_ID = 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz';
export const CONSOLE_BASE = 'https://analysis-console.test';

export const config: AnalysisConsoleConfig = {
  port: 8080,
  issuer: 'https://human-idp.test',
  clientId: 'analysis-console',
  clientSecret: 'analysis-console-secret',
  publicBaseUrl: CONSOLE_BASE,
  automationAppUrl: 'https://automation-app.test',
  storeMode: 'emulator',
};

export interface Harness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Scoped as this app: the path guard applies exactly as it would in production. */
  documents: DocumentStore;
  /** Scoped as security-detection: a finding is written by the detector, never here. */
  detectorSeed: DocumentStore;
  /** Scoped as the Provisioner, which is what writes an agent's registration. */
  provisionerSeed: DocumentStore;
  /** Every request the login flow made to the Human IdP. */
  upstream: Array<{ url: string; init: RequestInit }>;
  /** A cookie for a session that already exists, so a test can skip the login. */
  signIn(subject?: string): Promise<string>;
  /**
   * What the Human IdP's ID Token will say. A test sets it after `/login` has run,
   * because the nonce that ties a token to a login is only known once the request has
   * been built.
   */
  setIdTokenClaims(claims: Record<string, unknown>): void;
  /** Runs `/login` and returns the parameters this app put in the request. */
  beginLogin(): Promise<URLSearchParams>;
}

export async function startConsole(options: {
  now?: () => number;
  upstreamHandler?: (url: string, init: RequestInit) => Response | Promise<Response>;
} = {}): Promise<Harness> {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'analysis-console');
  const sessions = createSessionStore(documents);
  const upstream: Array<{ url: string; init: RequestInit }> = [];
  let claims: Record<string, unknown> = { sub: SUBJECT };

  const app = createApp({
    config,
    documents,
    // The signature check belongs to `verifyHumanIdToken` in production; here the claims
    // the far side would have produced are handed over directly, so the flow around it
    // — the transaction, the nonce, the session — is what these tests actually exercise.
    verifyIdToken: async (token) => {
      if (token === 'unverifiable') throw new Error('bad signature');
      return claims;
    },
    ...(options.now ? { now: options.now } : {}),
    fetchImpl: (async (url: string | URL | Request, init: RequestInit = {}) => {
      const target = String(url);
      upstream.push({ url: target, init });
      return options.upstreamHandler?.(target, init)
        ?? new Response(JSON.stringify({ id_token: 'id-token' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch,
  });

  const fetchPath = (path: string, init: RequestInit = {}): Promise<Response> =>
    app.fetch(new Request(new URL(path, CONSOLE_BASE), init));

  return {
    documents,
    detectorSeed: createFirestoreDocumentStore(firestore, 'security-detection'),
    provisionerSeed: createFirestoreDocumentStore(firestore, 'provisioner'),
    upstream,
    signIn: async (subject = SUBJECT) => {
      const session = await sessions.create(subject);
      return `xaa_console_session=${session.session_id}`;
    },
    setIdTokenClaims: (next) => { claims = next; },
    beginLogin: async () => {
      const started = await fetchPath('/login');
      return new URL(started.headers.get('location')!).searchParams;
    },
    fetch: fetchPath,
  };
}

/** A stored finding, exactly as Security Detection writes one. */
export function storedFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finding_id: 'f_1_abcdef01',
    finding_type: 'potential_agent_compromise',
    agent_id: AGENT_ID,
    human_subject: SUBJECT,
    window_start: '2026-01-01T12:00:00.000Z',
    window_end: '2026-01-01T12:10:00.000Z',
    // Two things the browser must never be handed: the ids of the log lines the finding
    // was made from, and the deviation records, each of which carries a trace id.
    related_events: ['corr-1', 'corr-2'],
    deviations: [{
      kind: 'unexpected_tool', observed: 'x', expected: [],
      occurred_at: '2026-01-01T12:01:00.000Z', trace_id: 'trace-1',
    }],
    contributing_codes: ['isolation.dedicated_op_mismatch'],
    risk_score: 85,
    risk_level: 'CRITICAL',
    review_status: 'pending',
    created_at: '2026-01-01T12:10:00.000Z',
    recommended_response: 'QUARANTINED',
    confidence: 0.82,
    analysis_source: 'model',
    analyzed_at: '2026-01-01T12:10:05.000Z',
    analysis: {
      deviation: { from_normal: '他の OP へ届いています', capability_consistency: '権限の範囲を超えています' },
      judgement: { compromise_likelihood: '高い', false_positive_likelihood: '低い', causality: '同一 trace です' },
      impact: { scope: 'この Agent のみ', op_propagation: '共有 OP への波及なし' },
      recommendation: { response: 'QUARANTINED', confidence: 0.82 },
    },
    ...overrides,
  };
}

/** A stored inspection, exactly as Security Detection writes one. */
export function storedInspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inspection_id: `i_1767268800_${AGENT_ID}`,
    agent_id: AGENT_ID,
    human_subject: SUBJECT,
    window_start: '2026-01-01T12:00:00.000Z',
    window_end: '2026-01-01T12:10:00.000Z',
    events_examined: 12,
    checks_run: [
      'protocol_validation', 'token_rate', 'authorization', 'tool',
      'lifetime', 'isolation', 'authorization_ai', 'baseline_deviation',
    ],
    checks_skipped: [],
    codes_raised: [],
    last_seen_at: '2026-01-01T12:09:00.000Z',
    ...overrides,
  };
}
