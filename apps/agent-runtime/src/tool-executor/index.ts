import type { LogContext, Logger } from '@xaa/logging';
import type { ExecutionContext } from '../context/execution-context.js';
import type { RuntimeHttpClient } from '../http/http-client.js';
import { buildResourceAuthorization } from '../http/resource-authorization.js';
import type { ToolCall } from '../reasoning/parse-tool-call.js';
import { createStageLogger, newSpanId, type StageLogger } from '../telemetry/stage-log.js';
import { fetchSubjectToken } from '../tokens/subject-token.js';
import type { ToolResult } from './errors.js';
import { buildToolIndex, isBlocked, resolveAllowedTool } from './steps/allowed-tools.js';
import { assertNotExpired } from './steps/expiration.js';
import { buildApiRequest } from './steps/build-api-request.js';
import { projectResponse } from './steps/project-response.js';
import { requestIdJag } from './steps/token-exchange.js';
import { selectRedeemer } from './steps/select-redeemer.js';
import { verifyConstraints } from './steps/verify-constraints.js';

export interface ToolExecutorDeps {
  context: ExecutionContext;
  http: RuntimeHttpClient;
  logger: Logger;
  logContext: LogContext;
  now?: () => number;
  stageWrite?: (line: string) => void;
}

/**
 * The seven steps, in order, with every gate that can stop a call placed before the
 * step that would make it observable elsewhere.
 *
 * Reading downwards: is this tool allowed at all; is the agent still within its
 * lifetime; do the constraints hold; only then does anything leave the process. The
 * ordering is the security property — REQ-02-026's "zero calls to the Agent OP" for an
 * out-of-permission request is true because step2 sits above the first `http.send`,
 * not because a later check happens to reject the response.
 */
export async function executeTool(deps: ToolExecutorDeps, call: ToolCall): Promise<ToolResult> {
  const now = deps.now ?? (() => Date.now());
  const stage: StageLogger = createStageLogger({
    executionId: deps.context.executionId,
    agentId: deps.context.agentId,
    taskId: deps.context.taskId,
    createdAt: deps.context.createdAt,
    expiresAt: deps.context.expiresAt,
    spanId: newSpanId(),
    now,
    ...(deps.stageWrite ? { write: deps.stageWrite } : {}),
  });

  stage.emit('agent_intent', { tool_id: call.tool_id, outcome: 'requested' });

  // step2
  const resolved = resolveAllowedTool(buildToolIndex(deps.context.manifest), call.tool_id);
  if (isBlocked(resolved)) {
    stage.emit('tool_selection', { tool_id: call.tool_id, outcome: 'blocked' });
    return resolved;
  }
  const tool = resolved;
  stage.emit('tool_selection', { tool_id: tool.tool_id, outcome: 'allowed' });

  // step3
  const expired = assertNotExpired(now(), deps.context.expiresAt, tool.tool_id);
  if (expired) {
    stage.emit('required_capability', { tool_id: tool.tool_id, outcome: 'agent_expired' });
    return expired;
  }
  stage.emit('required_capability', { tool_id: tool.tool_id, required_capability: tool.required_capability, outcome: 'resolved' });

  // step5.5 runs here, before any credential is minted: a call that will be refused
  // should not have produced an ID-JAG that outlives the refusal.
  const violated = verifyConstraints(tool, call.parameters);
  const authorization = tool.authorization;
  if (violated) {
    stage.emit('auth_mapping', { tool_id: tool.tool_id, outcome: 'constraint_violation' });
    return violated;
  }
  stage.emit('auth_mapping', {
    tool_id: tool.tool_id, audience: authorization.audience, resource: authorization.resource, scope: authorization.scope, outcome: 'mapped',
  });

  // step4
  const subjectToken = await fetchSubjectToken(deps.context, deps.http, now());
  const exchanged = await requestIdJag({ context: deps.context, http: deps.http, tool, subjectToken, now: now() });
  if ('outcome' in exchanged) {
    stage.emit('agent_op', { tool_id: tool.tool_id, outcome: exchanged.reason });
    return exchanged;
  }
  stage.emit('agent_op', { tool_id: tool.tool_id, outcome: 'exchanged' });
  stage.emit('id_jag', { tool_id: tool.tool_id, audience: authorization.audience, outcome: 'issued' });

  // step5
  const redeemed = await selectRedeemer(tool)({ context: deps.context, http: deps.http, tool, idJag: exchanged.idJag, now: now() });
  if ('outcome' in redeemed) {
    stage.emit('token_endpoint', { tool_id: tool.tool_id, outcome: redeemed.reason });
    return redeemed;
  }
  stage.emit('token_endpoint', { tool_id: tool.tool_id, audience: authorization.audience, outcome: 'redeemed' });
  stage.emit('access_token', {
    tool_id: tool.tool_id, scope: authorization.scope,
    outcome: 'bound', operation: `expires_at=${new Date(redeemed.expiresAt).toISOString()}`,
  });

  // step6
  const request = buildApiRequest(tool, call.parameters);
  if ('outcome' in request) {
    stage.emit('resource_api', { tool_id: tool.tool_id, outcome: request.reason });
    return request;
  }
  if (request.droppedParameters.length > 0) {
    stage.emit('resource_api', { tool_id: tool.tool_id, outcome: 'dropped_parameters', operation: request.droppedParameters.join(',') });
  }
  const startedAt = now();
  const response = await deps.http.send(request.url, {
    method: request.method,
    headers: {
      ...(await buildResourceAuthorization(redeemed.accessToken, { method: request.method, url: request.url }, deps.context.dpop, now)),
      'Content-Type': 'application/json',
    },
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  if (!response.ok) {
    stage.emit('resource_api', { tool_id: tool.tool_id, outcome: 'resource_api_error', latency_ms: now() - startedAt });
    return {
      outcome: 'failed', reason: 'resource_api_error', error_code: 'resource_api_error',
      tool_id: tool.tool_id, stage: 'resource_api', status: response.status,
    };
  }

  // step7
  const data = projectResponse(tool.response_schema, await response.json());
  stage.emit('resource_api', { tool_id: tool.tool_id, outcome: 'success', latency_ms: now() - startedAt });
  return { outcome: 'success', tool_id: tool.tool_id, stage: 'resource_api', data };
}
