import { createDpopProof, decodeJwsUnverified, importPrivateJwk, importPublicJwk, type Es256KeyPair, type PublicJwkEs256 } from '@xaa/crypto';
import { audienceIncludes } from '@xaa/contracts';
import type { Session, SessionAudience } from '../auth/session-store.js';

export class ControlPlaneCallError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`control plane call failed: ${status}`); }
}

export class TokenNotUsableHere extends Error {
  constructor(readonly audience: string) { super(`session token is not usable for ${audience}`); }
}

export interface ControlPlaneClient {
  send(target: SessionAudience, input: {
    url: string;
    method: string;
    body?: unknown;
    requiredScope: string;
  }): Promise<Response>;
}

/**
 * Every call this app makes on a user's behalf, with the same two headers.
 *
 * The Access Token is DPoP-bound, so the proof is not optional decoration: the
 * control plane rejects a token presented without one. The proof is built from the
 * destination URL, which is why the URL is passed in rather than assembled here from
 * a base and a path — an `htu` that disagreed with the request line would fail at the
 * far end, and silently, in a way that reads like an authorisation bug.
 *
 * The audience and scope are checked before sending. The receiving app checks them
 * too; doing it here means a misrouted token is a local error with a name rather than
 * a 403 from somewhere else.
 */
export function createControlPlaneClient(input: {
  session: Session;
  fetchImpl?: typeof fetch;
}): ControlPlaneClient {
  const send = input.fetchImpl ?? globalThis.fetch;
  return {
    async send(target, request) {
      const accessToken = input.session.access_tokens[target];
      if (!accessToken) throw new TokenNotUsableHere(target);
      const claims = decodeJwsUnverified(accessToken).payload;
      if (!audienceIncludes(claims.aud, target)) throw new TokenNotUsableHere(target);
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
      if (!scopes.includes(request.requiredScope)) throw new TokenNotUsableHere(target);

      const keyPair = await keyPairFrom(input.session.dpop_private_jwk);
      const headers: Record<string, string> = {
        Authorization: `DPoP ${accessToken}`,
        DPoP: await createDpopProof({ method: request.method, url: request.url, keyPair, accessToken }),
      };
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      return send(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    },
  };
}

/** The session stores the private JWK; the proof needs the pair. */
async function keyPairFrom(jwk: JsonWebKey): Promise<Es256KeyPair> {
  const publicJwk: PublicJwkEs256 = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
  return {
    privateKey: await importPrivateJwk(jwk),
    publicKey: await importPublicJwk(publicJwk),
    publicJwk,
  };
}
