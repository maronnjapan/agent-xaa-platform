import type { IdpConnectionResult, ProvisionerDeps } from '../deps.js';

export interface AgentOpClientOptions {
  /** The Agent OP's internal Cloud Run address, from `platform_endpoints`. */
  baseUrl: string;
  /** Mints a Google-signed ID Token for an origin; Cloud Run checks it at the edge. */
  identityToken(audience: string): Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * REQ-05-049 / RULE-51. How the Provisioner asks for, and asks about, an agent's IdP
 * connection.
 *
 * Three calls, and none of them carries a token belonging to a person. The Agent OP
 * runs the consent, redeems the authorization code and encrypts the refresh token; the
 * Provisioner learns only whether a connection exists and whether it is usable. That
 * split is what makes revoking one connection sufficient to end one agent's
 * delegation — there is no second copy of the credential anywhere to also revoke.
 *
 * The transport is service-to-service: the internal address plus this service
 * account's own ID Token, which is what Cloud Run's invoker check reads. There is no
 * browser leg here, and no path through which one could be added: the consent URL this
 * app returns points at Human IdP, and the browser comes back to the Agent OP.
 */
export function createAgentOpClient(options: AgentOpClientOptions): ProvisionerDeps['agentOp'] {
  const httpFetch = options.fetchImpl ?? globalThis.fetch;

  const call = async (path: string, body?: unknown): Promise<Response> => {
    const url = new URL(path, options.baseUrl).toString();
    const token = await options.identityToken(new URL(url).origin);
    const response = await httpFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`agent OP call failed: ${response.status}`);
    return response;
  };

  return {
    async createIdpConnection(input) {
      const response = await call('/internal/idp-connections', input);
      return response.json() as Promise<IdpConnectionResult>;
    },
    /**
     * Asked even when the creating call answered READY: that answer says the request
     * was accepted, and only this one says the refresh token behind it works now.
     */
    async verifyIdpConnection(idpConnectionId) {
      const response = await call(`/internal/idp-connections/${encodeURIComponent(idpConnectionId)}/verify`);
      return response.json() as Promise<{ status: string }>;
    },
    async revokeIdpConnection(idpConnectionId) {
      await call(`/internal/idp-connections/${encodeURIComponent(idpConnectionId)}/revoke`);
    },
  };
}
