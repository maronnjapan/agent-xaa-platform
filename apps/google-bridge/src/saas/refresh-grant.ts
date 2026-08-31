import { BridgeError } from '../errors.js';
import type { ConnectorDefinition } from '../connectors/types.js';
import type { AllowedHosts } from '../http/outbound.js';

export interface RefreshGrantResult {
  accessToken: string;
  expiresIn: number;
  scope: string;
  rotated: boolean;
}

export type SecretReader = (secretName: string) => Promise<string>;

/**
 * Exchanges the stored refresh token for a short-lived SaaS Access Token.
 *
 * The plaintext refresh token exists only inside this function: it is not returned, not
 * put in an error message, and not logged. Everything the caller needs is the access
 * token and whether a new refresh token arrived.
 *
 * A rotated refresh token overwrites the stored one in a single field update. Keeping
 * the old ciphertext anywhere — a history field, a backup collection — would be a
 * second copy of a credential the platform has just been told to stop using.
 *
 * `invalid_grant` from the SaaS means the person revoked the connection at the far end.
 * That is recorded, because trying again on the next request would produce the same
 * answer and leave the connection looking healthy. Any other failure leaves the status
 * alone: a 500 from the SaaS says nothing about the token.
 */
export async function runRefreshGrant(input: {
  connector: ConnectorDefinition;
  refreshToken: string;
  scope: readonly string[];
  readSecret: SecretReader;
  bridgeFetch: (url: string, init: RequestInit, allowed: AllowedHosts) => Promise<Response>;
  allowedHosts: AllowedHosts;
  timeoutMs?: number;
}): Promise<RefreshGrantResult & { newRefreshToken?: string }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.connector.client_id,
    client_secret: await input.readSecret(input.connector.secret_name),
    scope: input.scope.join(' '),
  });

  let response: Response;
  try {
    response = await input.bridgeFetch(input.connector.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      // No retry: a refresh token grant is not idempotent when the far side rotates.
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    }, input.allowedHosts);
  } catch {
    throw new BridgeError('invalid_grant', 502);
  }

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status < 500 && payload.error === 'invalid_grant') {
      throw new BridgeError('connection_revoked', 400);
    }
    throw new BridgeError('invalid_grant', 502);
  }
  if (typeof payload.access_token !== 'string') throw new BridgeError('invalid_grant', 502);

  return {
    // Only these three are read. An `id_token` in the response is dropped: it identifies
    // the person at the SaaS, and the agent has no business holding one.
    accessToken: payload.access_token,
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : 3600,
    scope: typeof payload.scope === 'string' ? payload.scope : input.scope.join(' '),
    rotated: typeof payload.refresh_token === 'string',
    ...(typeof payload.refresh_token === 'string' ? { newRefreshToken: payload.refresh_token } : {}),
  };
}
