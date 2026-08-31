/**
 * Cloud Run's `run.invoker` ID Token: proof that this service may be called, not
 * proof of who the agent is acting for.
 *
 * It is a different branded type from ResourceAccessToken so the two can never be
 * swapped. The distinction matters because they look identical on the wire — both are
 * a JWT in an Authorization header — and only the type keeps a platform identity from
 * arriving at a resource that would then act on the platform's behalf.
 *
 * The metadata server is reached only from this file, and only for the Agent OP and
 * the Bridge, which sit behind Cloud Run's own authentication.
 */
export type InvokerIdToken = string & { readonly __brand: 'invoker-id-token' };

const METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

export type InvokerAudience = 'agent-op' | 'bridge';

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
