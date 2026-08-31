import type { AgentOpClient, BridgeClient, ProvisionerClient, ResourceAsClient } from './types.js';

export type Send = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The internal calls this service makes, all through one injected sender.
 *
 * Every one carries a Cloud Run invoker ID Token for the destination, so the far side
 * knows it is `sa-lifecycle` asking. The status code comes back unwrapped: cleanup's
 * steps decide what 404 and 5xx mean for them, and a client that translated those into
 * exceptions would take that decision away.
 */
export function createInternalClients(input: {
  send?: Send;
  identityToken?: (audience: string) => Promise<string | undefined>;
  timeoutMs?: number;
}): AgentOpClient & ResourceAsClient & BridgeClient & ProvisionerClient {
  const send = input.send ?? ((url, init) => globalThis.fetch(url, init));

  const post = async (baseUrl: string, path: string, body?: unknown): Promise<Response> => {
    const url = new URL(path, baseUrl).toString();
    const token = await input.identityToken?.(new URL(url).origin);
    return send(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
  };

  return {
    async disableIssuance({ baseUrl, agentId }) {
      return (await post(baseUrl, `/internal/agents/${encodeURIComponent(agentId)}/disable-issuance`)).status;
    },
    async revokeIdpConnection({ baseUrl, agentId }) {
      // The Agent OP looks the connection up by agent: this service never handles the
      // encrypted token and has no key to read it with.
      return (await post(baseUrl, '/internal/revoke-connection', { agent_id: agentId })).status;
    },
    async revokeClientCredential({ baseUrl, agentId }) {
      return (await post(baseUrl, `/internal/agents/${encodeURIComponent(agentId)}/credentials/revoke`)).status;
    },
    async deleteRegistration({ baseUrl, agentId }) {
      return (await post(baseUrl, `/internal/agents/${encodeURIComponent(agentId)}/delete`)).status;
    },
    async revokeByActor({ baseUrl, actorSub }) {
      // One field. `human_subject` is deliberately absent: revocation is by actor, and
      // sending the person's id would invite a resource to widen the scope.
      return (await post(baseUrl, '/internal/revoke-by-actor', { actor_sub: actorSub })).status;
    },
    async disableBinding({ baseUrl, bindingId }) {
      return (await post(baseUrl, `/internal/agent-bindings/${encodeURIComponent(bindingId)}/disable`)).status;
    },
    async revokeUpstream({ baseUrl, connectionId }) {
      return (await post(baseUrl, `/internal/connections/${encodeURIComponent(connectionId)}/revoke-upstream`)).status;
    },
    async reprovision({ baseUrl, body }) {
      const response = await post(baseUrl, '/internal/provisioning/reprovision', body);
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
    },
  };
}
