/**
 * Cloud Run's `run.invoker` ID Token: proof that this service may be called, not
 * proof of who the agent is acting for.
 *
 * It is a different branded type from ResourceAccessToken so the two can never be
 * swapped. The distinction matters because they look identical on the wire — both are
 * a JWT in an Authorization header — and only the type keeps a platform identity from
 * arriving at a resource that would then act on the platform's behalf.
 *
 * The metadata server is reached only from this file, and only for the platform's own
 * services — the Agent OP, the Bridge, and the Native Resource AS and API of a
 * `native_xaa` tool — which sit behind Cloud Run's own authentication.
 * `buildInternalOrigins` is what names them; a destination outside that set never
 * reaches this provider, so no third party is ever shown a token for this Service
 * Account.
 */
export type InvokerIdToken = string & { readonly __brand: 'invoker-id-token' };

const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

export function createInvokerTokenProvider(input: {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  enabled?: boolean;
}): (audience: string) => Promise<InvokerIdToken | undefined> {
  const send = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return async (audience: string) => {
    if (input.enabled === false) return undefined;
    const response = await send(`${METADATA_URL}?audience=${encodeURIComponent(audience)}`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!response.ok) return undefined;
    return (await response.text()).trim() as InvokerIdToken;
  };
}

/**
 * The header Cloud Run's IAM check reads when the request already carries an
 * `Authorization` of its own.
 *
 * It is a separate header for a reason: the redemption at a Resource AS carries no
 * `Authorization` at all and the call to a Resource API carries the agent's DPoP-bound
 * one, and neither may be displaced by a credential that says nothing about who the
 * agent acts for. Cloud Run reads this one for its own check; the resource app reads
 * only `Authorization`, which is why reaching the route grants nothing (REQ-08-044).
 *
 * Built here, in the one module allowed to name a Bearer header, so a Service Account
 * token can never be assembled into a resource call by hand (T-RUN-15).
 */
export function invokerAuthorizationHeader(token: InvokerIdToken): Record<string, string> {
  return { 'X-Serverless-Authorization': `Bearer ${token}` };
}
