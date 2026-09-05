import type { LogContext, Logger } from '@xaa/logging';
import type { ExecutionContext } from '../context/execution-context.js';
import type { RuntimeHttpClient } from '../http/http-client.js';
import { buildExternalAuthorization, buildResourceAuthorization } from '../http/resource-authorization.js';
import type { ToolCall } from '../reasoning/parse-tool-call.js';
import type { ExecutionRecorder } from '../telemetry/execution-record.js';
import { createStageLogger, newSpanId, type Stage, type StageLogger } from '../telemetry/stage-log.js';
import { fetchSubjectToken, UnexpectedSubjectResponse } from '../tokens/subject-token.js';
import { toolFailed, type ToolResult, type ToolStage } from './errors.js';
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
  /**
   * Where the human-readable account of this call is written, when someone is
   * collecting one (docs 11 §3.4).
   *
   * Optional, and every call site is a bare method call rather than a branch: the
   * recorder is a sink, not a decision. Threading it through the deps rather than
   * deriving it from the stage log is what lets it carry the request and the answer,
   * which the stage log must not (RULE-55).
   */
  recorder?: ExecutionRecorder;
}

/**
 * One tool call, one result — including when something throws.
 *
 * A tool that cannot be run is a fact about that tool, not about the agent. The
 * Runtime used to let a throw out of here: `fetchSubjectToken` raised
 * `UnexpectedSubjectResponse`, nothing between it and `main` caught it, and one bad
 * step ended the Job Execution with `execution_failed` before the model was told
 * anything. The agent had seven other tools it could have tried and never got the
 * chance.
 *
 * So this wrapper is the boundary: below it a step may throw, above it the reasoning
 * loop always gets a `ToolResult` and decides what to do next. Every step that can
 * name its own failure still does — the catch is for what none of them predicted, and
 * reports it at the stage the call had actually reached.
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

  try {
    return await runSteps(deps, call, stage, now);
  } catch (error) {
    const reached = resultStage(stage.lastStage());
    // The message is for the operator, not for the model: it is the one place the
    // detail survives, and the only place a thrown string is allowed to land.
    deps.logger.error('tool_execution_error', deps.logContext, {
      tool_id: call.tool_id, stage: reached, message: (error as Error).message,
    });
    stage.emit(stage.lastStage(), { tool_id: call.tool_id, outcome: 'tool_execution_error' });
    deps.recorder?.stopped({ stage: reached, errorCode: 'tool_execution_error' });
    return toolFailed({ toolId: call.tool_id, stage: reached, errorCode: 'tool_execution_error' });
  }
}

/**
 * The stage log names two transitions the result vocabulary does not, and both sit
 * before any credential is asked for. `assertNotExpired` already reports a failure at
 * `required_capability` as `tool_selection`; this keeps that reading.
 */
const RESULT_STAGE: Readonly<Record<Stage, ToolStage>> = {
  agent_intent: 'tool_selection',
  tool_selection: 'tool_selection',
  required_capability: 'tool_selection',
  auth_mapping: 'auth_mapping',
  agent_op: 'agent_op',
  id_jag: 'id_jag',
  token_endpoint: 'token_endpoint',
  access_token: 'access_token',
  resource_api: 'resource_api',
};

function resultStage(stage: Stage): ToolStage {
  return RESULT_STAGE[stage];
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
async function runSteps(
  deps: ToolExecutorDeps,
  call: ToolCall,
  stage: StageLogger,
  now: () => number,
): Promise<ToolResult> {
  const record = deps.recorder;
  const index = buildToolIndex(deps.context.manifest);
  stage.emit('agent_intent', { tool_id: call.tool_id, outcome: 'requested' });

  // step2
  const resolved = resolveAllowedTool(index, call.tool_id);
  if (isBlocked(resolved)) {
    stage.emit('tool_selection', { tool_id: call.tool_id, outcome: 'blocked' });
    // No `stopped` beside it: a refusal is not a breakdown. `toolRefused` has already
    // said what was asked for, what was allowed instead, and that nothing was sent —
    // a second "止まったところ" panel would restate it in the vocabulary of failures.
    record?.toolRefused({ toolId: call.tool_id, allowedToolIds: [...index.keys()] });
    return resolved;
  }
  const tool = resolved;
  stage.emit('tool_selection', { tool_id: tool.tool_id, outcome: 'allowed' });
  record?.toolAllowed({
    toolId: tool.tool_id, allowedCount: index.size, requiredCapability: tool.required_capability,
  });

  // step3
  const expired = assertNotExpired(now(), deps.context.expiresAt, tool.tool_id);
  record?.lifetimeChecked({ expiresAt: deps.context.expiresAt, expired: expired !== null });
  if (expired) {
    stage.emit('required_capability', { tool_id: tool.tool_id, outcome: 'agent_expired' });
    record?.stopped({ stage: expired.stage, errorCode: expired.error_code });
    return expired;
  }
  stage.emit('required_capability', { tool_id: tool.tool_id, required_capability: tool.required_capability, outcome: 'resolved' });

  // step5.5 runs here, before any credential is minted: a call that will be refused
  // should not have produced an ID-JAG that outlives the refusal.
  const violated = verifyConstraints(tool, call.parameters);
  const authorization = tool.authorization;
  record?.constraintsChecked({
    names: Object.keys(tool.constraints), violated: violated?.constraint ?? null,
  });
  if (violated) {
    stage.emit('auth_mapping', { tool_id: tool.tool_id, outcome: 'constraint_violation' });
    return violated;
  }
  stage.emit('auth_mapping', {
    tool_id: tool.tool_id, audience: authorization.audience, resource: authorization.resource, scope: authorization.scope, outcome: 'mapped',
  });
  record?.authorizationMapped({
    audience: authorization.audience, resource: authorization.resource, scope: authorization.scope,
  });

  // step4. The subject token is fetched, not handed in, so the Agent OP being unable
  // to produce one is a failure of this call — the same kind as the exchange below it
  // failing, and reported the same way rather than as an exception (T-RUN-10).
  let subjectToken: string;
  try {
    subjectToken = await fetchSubjectToken(deps.context, deps.http, now());
  } catch (error) {
    // Only the OP answering badly is named here. A connection that never got an
    // answer is a different failure, and calling it `unexpected_subject_response`
    // would send whoever reads the timeline looking at the wrong service.
    if (!(error instanceof UnexpectedSubjectResponse)) throw error;
    deps.logger.error('subject_token_failed', deps.logContext, {
      tool_id: tool.tool_id, message: error.message,
    });
    stage.emit('agent_op', { tool_id: tool.tool_id, outcome: 'unexpected_subject_response' });
    record?.stopped({ stage: 'agent_op', errorCode: 'unexpected_subject_response' });
    return toolFailed({ toolId: tool.tool_id, stage: 'agent_op', errorCode: 'unexpected_subject_response' });
  }
  const exchanged = await requestIdJag({ context: deps.context, http: deps.http, tool, subjectToken, now: now() });
  if ('outcome' in exchanged) {
    stage.emit('agent_op', { tool_id: tool.tool_id, outcome: exchanged.reason });
    record?.stopped({ stage: exchanged.stage, errorCode: exchanged.error_code });
    return exchanged;
  }
  stage.emit('agent_op', { tool_id: tool.tool_id, outcome: 'exchanged' });
  stage.emit('id_jag', { tool_id: tool.tool_id, audience: authorization.audience, outcome: 'issued' });
  record?.idJagIssued({ audience: authorization.audience });

  // step5
  const redeemed = await selectRedeemer(tool)({ context: deps.context, http: deps.http, tool, idJag: exchanged.idJag, now: now() });
  if ('outcome' in redeemed) {
    stage.emit('token_endpoint', { tool_id: tool.tool_id, outcome: redeemed.reason });
    record?.stopped({ stage: redeemed.stage, errorCode: redeemed.error_code });
    return redeemed;
  }
  stage.emit('token_endpoint', { tool_id: tool.tool_id, audience: authorization.audience, outcome: 'redeemed' });
  stage.emit('access_token', {
    tool_id: tool.tool_id, scope: authorization.scope,
    outcome: 'bound', operation: `expires_at=${new Date(redeemed.expiresAt).toISOString()}`,
  });
  record?.accessTokenBound({
    audience: authorization.audience,
    binding: redeemed.binding,
    expiresAt: new Date(redeemed.expiresAt).toISOString(),
  });

  // step6
  const request = buildApiRequest(tool, call.parameters);
  if ('outcome' in request) {
    stage.emit('resource_api', { tool_id: tool.tool_id, outcome: request.reason });
    record?.stopped({ stage: request.stage, errorCode: request.error_code });
    return request;
  }
  if (request.droppedParameters.length > 0) {
    stage.emit('resource_api', { tool_id: tool.tool_id, outcome: 'dropped_parameters', operation: request.droppedParameters.join(',') });
  }
  record?.requestBuilt({
    method: request.method, url: request.url, body: request.body, dropped: request.droppedParameters,
  });
  const startedAt = now();
  // The redemption decided how the token is presented: DPoP-bound for a resource of
  // this platform, a plain Bearer for a SaaS reached over the Bridge (DEC-ID-13).
  const authorizationHeaders = redeemed.binding === 'bearer'
    ? buildExternalAuthorization(redeemed.accessToken)
    : await buildResourceAuthorization(redeemed.accessToken, { method: request.method, url: request.url }, deps.context.dpop, now);
  const response = await deps.http.send(request.url, {
    method: request.method,
    headers: {
      ...authorizationHeaders,
      'Content-Type': 'application/json',
    },
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  if (!response.ok) {
    stage.emit('resource_api', { tool_id: tool.tool_id, outcome: 'resource_api_error', latency_ms: now() - startedAt });
    record?.stopped({ stage: 'resource_api', errorCode: 'resource_api_error', status: response.status });
    return {
      outcome: 'failed', reason: 'resource_api_error', error_code: 'resource_api_error',
      tool_id: tool.tool_id, stage: 'resource_api', status: response.status,
    };
  }

  // step7
  const data = projectResponse(tool.response_schema, await response.json());
  stage.emit('resource_api', { tool_id: tool.tool_id, outcome: 'success', latency_ms: now() - startedAt });
  record?.responseReceived({
    status: response.status,
    latencyMs: now() - startedAt,
    body: data,
    allowlist: tool.response_schema.allowlist,
  });
  return { outcome: 'success', tool_id: tool.tool_id, stage: 'resource_api', data };
}
