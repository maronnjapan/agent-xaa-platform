/**
 * The Bridge's only way out to the network.
 *
 * GCP services — KMS, Secret Manager, Firestore — are reached through their client
 * SDKs over gRPC and do not pass through here. That is why they are absent from the
 * allow list rather than forgotten: this wrapper governs HTTP the Bridge originates,
 * and the SDKs are a different transport with their own IAM.
 */
export class OutboundNotAllowedError extends Error {
  readonly code = 'outbound_not_allowed';
  constructor(readonly host: string) { super(`outbound_not_allowed: ${host}`); }
}

export type AllowedHosts = ReadonlySet<string>;

export type Send = (url: string, init: RequestInit) => Promise<Response>;

/**
 * RULE-21, as a list of host names built per request.
 *
 * docs 06 §2 says the Bridge does not relay business APIs. The way to make that true
 * rather than merely stated is for the Bridge to have nowhere to send such a request:
 * the allow list holds the current connector's four OAuth endpoints and the two JWKS
 * hosts, and nothing accumulates across requests.
 *
 * Redirects are not followed. A 302 from a token endpoint would be a way to move the
 * destination outside the list after the check.
 */
export function createBridgeFetch(send: Send = (url, init) => globalThis.fetch(url, init)) {
  return async function bridgeFetch(url: string, init: RequestInit, allowed: AllowedHosts): Promise<Response> {
    let target: URL;
    try { target = new URL(url); } catch { throw new OutboundNotAllowedError(url); }
    if (target.protocol !== 'https:') throw new OutboundNotAllowedError(target.protocol);
    if (!allowed.has(target.host)) throw new OutboundNotAllowedError(target.host);
    return send(url, { ...init, redirect: 'manual' });
  };
}

export function allowedHostsFor(input: {
  connector?: { authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string; userinfo_endpoint: string };
  jwksUrl: string;
}): AllowedHosts {
  const hosts = new Set<string>(['www.googleapis.com', new URL(input.jwksUrl).host]);
  if (input.connector) {
    for (const endpoint of [
      input.connector.authorization_endpoint, input.connector.token_endpoint,
      input.connector.revocation_endpoint, input.connector.userinfo_endpoint,
    ]) hosts.add(new URL(endpoint).host);
  }
  return hosts;
}
