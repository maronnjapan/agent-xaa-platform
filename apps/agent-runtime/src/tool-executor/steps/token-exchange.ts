import { createDpopProof } from '@xaa/crypto';
import {
  AGENT_CLIENT_AUTH_ASSERTION_TYPE, ID_JAG_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ID_TOKEN, TOKEN_TYPE_JWT,
} from '@xaa/contracts';
import type { ExecutionContext } from '../../context/execution-context.js';
import type { RuntimeHttpClient } from '../../http/http-client.js';
import type { ToolDefinition } from '../../manifest/load.js';
import { buildActorToken } from '../../tokens/agent-assertion.js';
import { buildClientAssertion } from '../../tokens/client-assertion.js';
import { idJagKey } from '../../tokens/token-store.js';
import type { ToolFailed } from '../errors.js';

export const TOKEN_EXCHANGE_PATH = '/xaa/token';
export const TOKEN_EXCHANGE_BODY_KEYS = [
  'grant_type', 'requested_token_type', 'subject_token', 'subject_token_type',
  'actor_token', 'actor_token_type', 'audience', 'resource', 'scope',
] as const;

/**
 * step4. Nine fields, every one of them from the manifest or from this execution.
 *
 * The signature takes a `ToolDefinition`, not a `ToolCall`: REQ-05-064 forbids mixing
 * model output into the exchange, and the surest way to keep that true is for the
 * model's object never to be in scope here. `audience`, `resource` and `scope` are
 * copied verbatim — no trailing-slash repair, no normalisation — because the OP
 * compares them to what the Provisioner registered, byte for byte.
 */
export function buildTokenExchangeBody(input: {
  tool: ToolDefinition;
  subjectToken: string;
  actorToken: string;
}): Record<string, string> {
  return {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    subject_token: input.subjectToken,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    actor_token: input.actorToken,
    actor_token_type: TOKEN_TYPE_JWT,
    audience: input.tool.authorization.audience,
    resource: input.tool.authorization.resource,
    scope: input.tool.authorization.scope,
  };
}

export interface IdJagResult {
  idJag: string;
  expiresInSeconds: number;
}

export async function requestIdJag(input: {
  context: ExecutionContext;
  http: RuntimeHttpClient;
  tool: ToolDefinition;
  subjectToken: string;
  now?: number;
}): Promise<IdJagResult | ToolFailed> {
  const now = input.now ?? Date.now();
  const url = `${input.context.agentOpBaseUrl}${TOKEN_EXCHANGE_PATH}`;
  const body = buildTokenExchangeBody({
    tool: input.tool,
    subjectToken: input.subjectToken,
    actorToken: await buildActorToken(input.context, now),
  });
  const response = await input.http.send(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: await createDpopProof({ method: 'POST', url, keyPair: input.context.dpop, now: () => now }),
    },
    // Client authentication rides alongside the grant, not inside it: the nine keys
    // above are the exchange, and these two say who is asking (DEC-ID-11).
    body: new URLSearchParams({
      ...body,
      client_assertion: await buildClientAssertion(input.context, TOKEN_EXCHANGE_PATH, now),
      client_assertion_type: AGENT_CLIENT_AUTH_ASSERTION_TYPE,
    }).toString(),
  });
  if (!response.ok) {
    // No retry, on any status. A 5xx retry would replay the proof and reuse the jti;
    // a 4xx retry would ask the same question again. Neither is the Runtime's call.
    return {
      outcome: 'failed', reason: 'agent_op_error', error_code: 'agent_op_error',
      tool_id: input.tool.tool_id, stage: 'agent_op', status: response.status,
    };
  }
  const payload = await response.json() as Record<string, unknown>;
  if (payload.issued_token_type !== ID_JAG_TOKEN_TYPE || typeof payload.access_token !== 'string') {
    return {
      outcome: 'failed', reason: 'unexpected_token_type', error_code: 'unexpected_token_type',
      tool_id: input.tool.tool_id, stage: 'id_jag',
    };
  }
  const expiresInSeconds = typeof payload.expires_in === 'number' ? payload.expires_in : 300;
  input.context.tokens.set(idJagKey(input.tool.tool_id), payload.access_token, now + expiresInSeconds * 1000);
  return { idJag: payload.access_token, expiresInSeconds };
}
