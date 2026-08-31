import { JWT_BEARER_GRANT_TYPE } from '@xaa/contracts';
import { asResourceAccessToken } from '../../http/resource-authorization.js';
import type { Redeemer } from './redeem-id-jag.js';

/**
 * step5, bridged path. The Bridge exchanges an ID-JAG for the external SaaS's own
 * Access Token, and hands it back — it does not call the SaaS.
 *
 * That split is the Bridge's whole design (docs 06 §4): it holds the external OAuth
 * connection, so it is a credential exchange, not a proxy. If it executed the business
 * call, every SaaS request in the platform would run with the Bridge's identity and
 * the delegation chain would end there.
 *
 * The token that comes back is a plain external Bearer token. DEC-ID-13: DPoP is a
 * platform-internal binding, and an outbound SaaS request must look like what the SaaS
 * issued, not like something this platform invented.
 */
export const redeemViaBridge: Redeemer = async (input) => {
  const now = input.now ?? Date.now();
  const provider = input.tool.token_provider;
  if (provider === null) {
    return {
      outcome: 'failed', reason: 'bridge_error', error_code: 'bridge_error',
      tool_id: input.tool.tool_id, stage: 'token_endpoint',
    };
  }
  const response = await input.http.send(`${provider}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion: input.idJag,
      resource: input.tool.authorization.resource,
    }).toString(),
  });
  if (!response.ok) {
    return {
      outcome: 'failed', reason: 'bridge_error', error_code: 'bridge_error',
      tool_id: input.tool.tool_id, stage: 'token_endpoint', status: response.status,
    };
  }
  const payload = await response.json() as Record<string, unknown>;
  if (typeof payload.access_token !== 'string') {
    return {
      outcome: 'failed', reason: 'unexpected_token_type', error_code: 'unexpected_token_type',
      tool_id: input.tool.tool_id, stage: 'access_token',
    };
  }
  const expiresAt = now + (typeof payload.expires_in === 'number' ? payload.expires_in : 300) * 1000;
  return { accessToken: asResourceAccessToken(payload.access_token, 'bridge'), expiresAt, idJagJti: undefined };
};
