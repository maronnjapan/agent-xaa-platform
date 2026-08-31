import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { createLogger, type LogContext, type Logger } from '@xaa/logging';
import type { ToolManifest } from '@xaa/contracts';
import { createExecutionContext, type ExecutionContext } from '@xaa/agent-runtime/src/context/execution-context';
import { manifestSha256 } from '@xaa/agent-runtime/src/manifest/load';
import { createRuntimeStore } from '@xaa/agent-runtime/src/store/runtime-store';
import { buildAllowedHosts } from '@xaa/agent-runtime/src/http/allowed-hosts';
import { createRuntimeHttpClient, type RuntimeHttpClient } from '@xaa/agent-runtime/src/http/http-client';
import type { AgentOpHarness } from './agent-op.js';
import type { ResourceHarness } from './resource.js';

export interface RuntimeHarness {
  context: ExecutionContext;
  http: RuntimeHttpClient;
  logger: Logger;
  logContext: LogContext;
  documents: DocumentStore;
  stageLines: string[];
  /** One entry per outbound request, so a spec can assert who was never called. */
  hostCalls: string[];
}

export interface StartRuntimeOptions {
  agentOp: AgentOpHarness;
  agentOpBaseUrl: string;
  /** Every resource the manifest can reach, keyed by nothing: matched on issuer/uri. */
  resources: ResourceHarness[];
  manifest: ToolManifest;
  humanSubject?: string;
  taskId?: string;
  expiresAt?: string;
  agentClientPrivateJwk: string;
}

/**
 * Wires a real Agent Runtime to the real apps in one process (DEC-TEST-01).
 *
 * The Runtime's own `httpClient` is given a transport that routes an absolute URL to
 * whichever app owns that host, so every request the Runtime makes is served by the
 * service that would serve it in production — no hand-minted token anywhere, and
 * `globalThis.fetch` is never reached.
 */
export async function startAgentRuntime(options: StartRuntimeOptions): Promise<RuntimeHarness> {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'agent-runtime');
  const store = createRuntimeStore({ documents, agentId: options.agentOp.agentId });
  const raw = JSON.stringify(options.manifest);
  const context = await createExecutionContext({
    env: {
      AGENT_ID: options.agentOp.agentId,
      HUMAN_SUBJECT: options.humanSubject ?? 'testuser',
      TASK_ID: options.taskId ?? 'task-1',
      AGENT_CREATED_AT: new Date(Date.now() - 60_000).toISOString(),
      AGENT_EXPIRES_AT: options.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
      AGENT_OP_BASE_URL: options.agentOpBaseUrl,
      TOOL_MANIFEST: raw,
      TOOL_MANIFEST_SHA256: manifestSha256(raw),
      AGENT_CLIENT_PRIVATE_JWK: options.agentClientPrivateJwk,
      ISOLATION_LEVEL: 'standard',
      executionId: 'e2e-execution',
      taskIndex: 0,
    },
    store,
    processEnv: {},
  });

  const hostCalls: string[] = [];
  const http = createRuntimeHttpClient({
    allowedHosts: buildAllowedHosts({ AGENT_OP_BASE_URL: options.agentOpBaseUrl }, context.manifest),
    fetch: async (url, init) => {
      hostCalls.push(new URL(url).origin);
      const target = new URL(url);
      if (target.origin === new URL(options.agentOpBaseUrl).origin) {
        return options.agentOp.fetch(`${target.pathname}${target.search}`, init);
      }
      for (const resource of options.resources) {
        if (target.origin === new URL(resource.asIssuer).origin) return resource.as(`${target.pathname}${target.search}`, init);
        if (target.origin === new URL(resource.resourceUri).origin) return resource.api(`${target.pathname}${target.search}`, init);
      }
      throw new Error(`no app is wired for ${target.origin}`);
    },
  });

  const stageLines: string[] = [];
  return {
    context, http, documents, stageLines, hostCalls,
    logger: createLogger('agent-runtime', 'agent_runtime', () => {}),
    logContext: {
      request_id: 'e2e', trace_id: 'e2e-trace',
      agent_id: options.agentOp.agentId, human_subject: options.humanSubject ?? 'testuser',
    },
  };
}

export function nativeManifest(input: {
  agentId: string;
  resource: ResourceHarness;
  expiresAt?: string;
  kind: 'docs' | 'finance';
}): ToolManifest {
  const docs: ToolManifest['tools'] = [
    {
      tool_id: 'internal.document.list', description: '書類の一覧を取得する', required_capability: 'document.read',
      authorization: { type: 'native_xaa', audience: input.resource.asIssuer, resource: input.resource.resourceUri, scope: 'docs.read' },
      token_provider: null,
      api: { base_url: input.resource.resourceUri, method: 'GET', path: '/documents' },
      parameters: {}, constraints: {},
      response_schema: { type: 'array', allowlist: ['document_id', 'title', 'type'] },
    },
    {
      tool_id: 'internal.document.get', description: '書類を1件取得する', required_capability: 'document.read',
      authorization: { type: 'native_xaa', audience: input.resource.asIssuer, resource: input.resource.resourceUri, scope: 'docs.read' },
      token_provider: null,
      api: { base_url: input.resource.resourceUri, method: 'GET', path: '/documents/{id}' },
      parameters: { id: { type: 'string', required: true } }, constraints: {},
      response_schema: { type: 'object', allowlist: ['document_id', 'title', 'body'] },
    },
  ];
  const finance: ToolManifest['tools'] = [
    {
      tool_id: 'internal.finance.payment.list', description: '支払の一覧を取得する', required_capability: 'finance.payment.read',
      authorization: { type: 'native_xaa', audience: input.resource.asIssuer, resource: input.resource.resourceUri, scope: 'finance.tx.read' },
      token_provider: null,
      api: { base_url: input.resource.resourceUri, method: 'GET', path: '/payments' },
      parameters: {}, constraints: {},
      response_schema: { type: 'array', allowlist: ['payment_id', 'amount', 'status'] },
    },
    {
      tool_id: 'internal.finance.payment.approve', description: '支払を承認する', required_capability: 'finance.payment.approve',
      authorization: { type: 'native_xaa', audience: input.resource.asIssuer, resource: input.resource.resourceUri, scope: 'finance.tx.write' },
      token_provider: null,
      api: { base_url: input.resource.resourceUri, method: 'POST', path: '/payments/{id}/approve' },
      parameters: { id: { type: 'string', required: true }, amount: { type: 'number', required: true } },
      constraints: { max_amount: 500000 },
      response_schema: { type: 'object', allowlist: ['payment_id', 'status', 'approved_by', 'approved_by_agent'] },
    },
  ];
  return {
    agent_id: input.agentId,
    expires_at: input.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    tools: input.kind === 'docs' ? docs : finance,
  };
}
