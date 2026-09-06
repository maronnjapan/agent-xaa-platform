import type { BridgeClient } from '../deps.js';

export interface BridgeClientOptions {
  /** The Bridge's internal Cloud Run address, from `platform_endpoints.bridge_internal_url`. */
  baseUrl: string;
  /** Mints a Google-signed ID Token for an origin; Cloud Run checks it at the edge. */
  identityToken(audience: string): Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * RULE-24. How the Provisioner asks for, and asks about, an agent's connection to an
 * external SaaS.
 *
 * The shape is deliberately the Agent OP client's (`agent/idp-connection.ts`): the two
 * halves of a delegation are the same question asked of two services, and writing them
 * differently would invite them to drift. Both are service-to-service, both send this
 * service account's own ID Token for the Cloud Run invoker check, and neither carries a
 * token belonging to a person. The Bridge holds the refresh token; the Provisioner
 * learns only whether a connection exists, whether it covers the scopes the agent needs,
 * and what the binding it asked for is called.
 *
 * The browser leg is not here and cannot be added: `check` returns a consent URL on the
 * Bridge's own public callback face, and the browser comes back to the Automation App.
 */
export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const httpFetch = options.fetchImpl ?? globalThis.fetch;

  const call = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => {
    const url = new URL(path, options.baseUrl).toString();
    const token = await options.identityToken(new URL(url).origin);
    const response = await httpFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`bridge call failed: ${response.status}`);
    return response;
  };

  return {
    /**
     * The transaction id travels in a header rather than the body because the Bridge
     * refuses a `/connections/check` body that is not exactly its three keys, and
     * because the Bridge must not create a transaction of its own from it — the
     * consent URL it builds only quotes the one this service already made (T-BRIDGE-13).
     */
    async checkConnection(input) {
      const response = await call('/connections/check', {
        connector_id: input.connectorId,
        human_subject: input.humanSubject,
        required_scopes: input.requiredScopes,
      }, { 'X-Transaction-Id': input.transactionId });
      return response.json() as Promise<
        | { status: 'READY'; connection_id: string }
        | { status: 'CONSENT_REQUIRED'; consent_url: string; missing_scopes: string[] }
      >;
    },

    /**
     * Asked on the way back, and it is the Bridge that spends the one-time code: the
     * code was minted by the Bridge's callback into the Bridge's own store, so this
     * service never holds it as anything but a string to hand on. A code says the
     * browser came back; this answer says the connection behind it is usable.
     */
    async verifyConnection(input) {
      const response = await call('/connections/verify', {
        transaction_id: input.transactionId,
        one_time_code: input.oneTimeCode,
      });
      return response.json() as Promise<{ status: string; connection_id: string; granted_scopes: string[] }>;
    },

    /**
     * RULE-24's narrowing step. The connection is the person's and outlives any one
     * agent; the binding is this agent's slice of it, and it is what `/token` reads.
     * Without one the agent holds an ID-JAG the Bridge will not exchange.
     */
    async createBinding(input) {
      const response = await call('/bindings', {
        agent_id: input.agentId,
        connector_id: input.connectorId,
        connection_id: input.connectionId,
        human_subject: input.humanSubject,
        scopes: input.scopes,
        expires_at: input.expiresAt,
      });
      return response.json() as Promise<{ binding_id: string; expires_at: string }>;
    },
  };
}
