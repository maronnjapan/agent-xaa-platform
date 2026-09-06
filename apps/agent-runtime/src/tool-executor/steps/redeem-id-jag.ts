import { createDpopProof, decodeJwsUnverified } from '@xaa/crypto';
import { JWT_BEARER_GRANT_TYPE, PLATFORM_CLIENT_ID } from '@xaa/contracts';
import type { ExecutionContext } from '../../context/execution-context.js';
import type { RuntimeHttpClient } from '../../http/http-client.js';
import type { ToolDefinition } from '../../manifest/load.js';
import { asResourceAccessToken } from '../../http/resource-authorization.js';
import { accessTokenKey, type HeldAccessToken, type LiveAccessToken } from '../../tokens/token-store.js';
import type { ToolFailed } from '../errors.js';

/**
 * What a redemption produced: the token, how it is presented, until when — and the
 * `jti` of the grant it came from, which the store has no use for and does not keep.
 *
 * The `binding` is the redeemer's decision, not the caller's, so the header can never
 * contradict what was issued.
 */
export interface RedeemedAccessToken extends LiveAccessToken {
  idJagJti: string | undefined;
}

export type Redeemer = (input: {
  context: ExecutionContext;
  http: RuntimeHttpClient;
  tool: ToolDefinition;
  idJag: string;
  now?: number;
}) => Promise<RedeemedAccessToken | ToolFailed>;

/**
 * step5, native path. The ID-JAG becomes an Access Token at the resource's own AS.
 *
 * There is no client secret and no Basic header. DEC-ID-14: the client is
 * authenticated by possession of the DPoP key the ID-JAG's `cnf.jkt` names, which is
 * stronger than a shared secret and, unlike one, cannot be copied out of the manifest.
 *
 * The endpoint is the audience plus `/token` (DEV-09). The audience is the AS issuer,
 * so a discovery round trip would only re-derive a value the manifest already fixed —
 * and would introduce exactly the run-time resolution REQ-04-015 forbids.
 */
export const redeemIdJag: Redeemer = async (input) => {
  const now = input.now ?? Date.now();
  const url = `${input.tool.authorization.audience}/token`;
  const response = await input.http.send(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: await createDpopProof({ method: 'POST', url, keyPair: input.context.dpop, now: () => now }),
    },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion: input.idJag,
      client_id: PLATFORM_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    // A 4xx is an answer, not a suggestion to try a smaller scope. Retrying with
    // different parameters would be the Runtime negotiating its own permissions.
    return {
      outcome: 'failed', reason: 'resource_as_error', error_code: 'resource_as_error',
      tool_id: input.tool.tool_id, stage: 'token_endpoint', status: response.status,
    };
  }
  const payload = await response.json() as Record<string, unknown>;
  if (payload.token_type !== 'DPoP' || typeof payload.access_token !== 'string') {
    return {
      outcome: 'failed', reason: 'unexpected_token_type', error_code: 'unexpected_token_type',
      tool_id: input.tool.tool_id, stage: 'access_token',
    };
  }
  const expiresAt = now + (typeof payload.expires_in === 'number' ? payload.expires_in : 300) * 1000;
  const held: HeldAccessToken = {
    accessToken: asResourceAccessToken(payload.access_token, 'resource-as'),
    binding: 'dpop',
  };
  // Stored under the audience, resource and scope it was issued for, which is exactly
  // the question the next tool call asks: not "which tool is this" but "what may this
  // token be used for". Two tools sharing one authorization share the one token.
  input.context.tokens.set(accessTokenKey(input.tool.authorization), held, expiresAt);
  // The jti identifies the grant in the logs; the assertion itself never appears there.
  return { ...held, expiresAt, idJagJti: readJti(input.idJag) };
};

function readJti(idJag: string): string | undefined {
  try {
    const jti = decodeJwsUnverified(idJag).payload.jti;
    return typeof jti === 'string' ? jti : undefined;
  } catch { return undefined; }
}
