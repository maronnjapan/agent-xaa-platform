import { basicClientAuthHeader, PLATFORM_CLIENT_ID } from '@xaa/contracts';
import type { AgentOpConfig } from '../config.js';

/**
 * `agent-platform` is a confidential client at the Human IdP, so every back-channel
 * call — the authorization_code exchange, the refresh_token grant and RFC 7009
 * revocation — carries HTTP Basic client authentication. Sending `client_id` alone
 * is answered with 401 invalid_client, which looked like a revoked token and let
 * cleanup report success while the person's refresh token was still live.
 *
 * The encoding of the two values is `basicClientAuthHeader`'s to get right; building
 * the header here by hand is what sent the raw secret and drew the same 401.
 */
export function humanIdpClientAuthHeader(config: AgentOpConfig): string {
  return basicClientAuthHeader(PLATFORM_CLIENT_ID, config.clientSecretAgentPlatform);
}
