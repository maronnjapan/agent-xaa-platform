import { GoogleAuth } from 'google-auth-library';

export interface IdTokenAuth {
  getIdTokenClient(audience: string): Promise<{
    idTokenProvider: { fetchIdToken(targetAudience: string): Promise<string> };
  }>;
}

/**
 * Returns a Cloud Run identity-token provider backed by Application Default
 * Credentials. The audience is always supplied by the destination call site; no
 * token is shared between services with different origins.
 */
export function createIdentityTokenProvider(auth: IdTokenAuth = new GoogleAuth()): (audience: string) => Promise<string> {
  const clients = new Map<string, Awaited<ReturnType<IdTokenAuth['getIdTokenClient']>>>();
  return async (audience) => {
    if (!audience.startsWith('https://') && !audience.startsWith('http://localhost')) {
      throw new Error('identity token audience must be an absolute HTTPS origin');
    }
    let client = clients.get(audience);
    if (!client) {
      client = await auth.getIdTokenClient(audience);
      clients.set(audience, client);
    }
    return client.idTokenProvider.fetchIdToken(audience);
  };
}
