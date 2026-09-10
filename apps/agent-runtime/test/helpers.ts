import { webcrypto } from 'node:crypto';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLogger, type LogContext } from '@xaa/logging';
import { buildSubjectTokenResponse, type ToolManifest } from '@xaa/contracts';
import { createExecutionContext, type ExecutionContext } from '../src/context/execution-context.js';
import { manifestSha256 } from '../src/manifest/load.js';
import { createRuntimeStore, type RuntimeStore } from '../src/store/runtime-store.js';
import { buildAllowedHosts } from '../src/http/allowed-hosts.js';
import { createRuntimeHttpClient, type Fetch } from '../src/http/http-client.js';
import type { RuntimeEnv } from '../src/env.js';

export const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
export const AGENT_OP = 'https://agent-op.example.test';
export const DOCS_AS = 'https://docs-as.example.test';
export const DOCS_API = 'https://docs-api.example.test';

export const logContext: LogContext = { request_id: 'r', trace_id: 't', agent_id: AGENT_ID, human_subject: 'testuser' };
export const silentLogger = createLogger('agent-runtime', 'agent_runtime', () => {});

export function docsManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    agent_id: AGENT_ID,
    expires_at: '2999-01-01T00:00:00.000Z',
    tools: [
      {
        tool_id: 'internal.document.list',
        description: 'List documents',
        required_capability: 'document.read',
        authorization: { type: 'native_xaa', audience: DOCS_AS, resource: DOCS_API, scope: 'docs.read' },
        token_provider: null,
        api: { base_url: DOCS_API, method: 'GET', path: '/documents' },
        parameters: {},
        constraints: {},
        response_schema: { type: 'array', allowlist: ['document_id', 'title'] },
      },
      {
        tool_id: 'internal.document.get',
        description: 'Get a document',
        required_capability: 'document.read',
        authorization: { type: 'native_xaa', audience: DOCS_AS, resource: DOCS_API, scope: 'docs.read' },
        token_provider: null,
        api: { base_url: DOCS_API, method: 'GET', path: '/documents/{id}' },
        parameters: { id: { type: 'string', required: true } },
        constraints: {},
        response_schema: { type: 'object', allowlist: ['document_id', 'title', 'body'] },
      },
    ],
    ...overrides,
  };
}

export async function agentClientJwk(): Promise<string> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return JSON.stringify(await webcrypto.subtle.exportKey('jwk', pair.privateKey));
}

export async function runtimeEnv(manifest: ToolManifest = docsManifest()): Promise<RuntimeEnv> {
  const raw = JSON.stringify(manifest);
  return {
    AGENT_ID,
    HUMAN_SUBJECT: 'testuser',
    TASK_ID: 'task-1',
    AGENT_CREATED_AT: '2026-01-01T00:00:00.000Z',
    AGENT_EXPIRES_AT: manifest.expires_at,
    AGENT_OP_BASE_URL: AGENT_OP,
    TOOL_MANIFEST: raw,
    TOOL_MANIFEST_SHA256: manifestSha256(raw),
    AGENT_CLIENT_PRIVATE_JWK: await agentClientJwk(),
    ISOLATION_LEVEL: 'standard',
    executionId: 'execution-1',
    taskIndex: 0,
  };
}

export function memoryStore(agentId = AGENT_ID): { store: RuntimeStore; documents: ReturnType<typeof createFirestoreDocumentStore> } {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
  return { store: createRuntimeStore({ documents, agentId }), documents };
}

export interface Recorded { url: string; init: RequestInit }

export function recordingFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: Fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function testContext(input: {
  manifest?: ToolManifest;
  agentId?: string;
} = {}): Promise<ExecutionContext> {
  const manifest = input.manifest ?? docsManifest();
  const env = await runtimeEnv(manifest);
  return createExecutionContext({ env, store: memoryStore(input.agentId ?? AGENT_ID).store, processEnv: {} });
}

export function testHttp(context: ExecutionContext, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const recorder = recordingFetch(handler);
  return {
    calls: recorder.calls,
    http: createRuntimeHttpClient({
      allowedHosts: buildAllowedHosts({ AGENT_OP_BASE_URL: context.agentOpBaseUrl }, context.manifest),
      fetch: recorder.fetch,
    }),
  };
}

/** A syntactically real ID Token: the Runtime reads `exp` off it to decide caching. */
export function fakeIdToken(expSeconds = Math.floor(Date.now() / 1000) + 3600): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub: 'testuser', exp: expSeconds })}.signature`;
}

/**
 * The `/xaa/subject-token` body, built by the same function the Agent OP answers with.
 *
 * Hand-written mocks are how `subject_token` and `id_token` drifted apart unnoticed:
 * the Runtime's tests described a response the OP never sends, and stayed green while
 * every real execution failed. A double that no longer resembles the service is worse
 * than none, so this one is built rather than typed out.
 */
export function subjectTokenResponse(expSeconds?: number): Record<string, unknown> {
  return { ...buildSubjectTokenResponse({ idToken: fakeIdToken(expSeconds) }) };
}
