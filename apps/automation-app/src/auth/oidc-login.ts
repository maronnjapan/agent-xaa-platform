import { randomUUID } from 'node:crypto';
import { sha256Base64Url } from '@xaa/crypto';

/**
 * The scope this app asks for, and the scope it will never ask for.
 *
 * `openid profile` and nothing else. There is no branch that adds `offline_access`,
 * because a refresh token here would let the screen keep acting as the user after
 * they close it — and the whole point of the XAA design is that an agent's continued
 * access comes from its own delegation, not from a copy of the person's session
 * (DEC-ID-13).
 */
export const LOGIN_SCOPE = 'openid profile';

/**
 * Where this app reads the keys that verify the Human IdP's tokens.
 *
 * OpenID Discovery's registered location, not `${issuer}/jwks.json`: the IdP serves
 * the set at `/.well-known/jwks.json` and answers 404 anywhere else, and a 404 here
 * fails every ID Token and Access Token the same way a bad signature would.
 *
 * The IdP's own endpoint rather than the `jwks_uri` its metadata advertises, which
 * points at the bucket the whole platform publishes into. Only tokens this issuer
 * minted are verified with this set, and the issuer's own endpoint is the copy that
 * cannot lag a key rotation.
 */
export function humanIdpJwksUrl(issuer: string): string {
  return `${issuer}/.well-known/jwks.json`;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export async function buildAuthorizationRequest(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  prompt?: 'none' | 'login' | 'consent';
}): Promise<AuthorizationRequest> {
  const state = randomUUID();
  const codeVerifier = randomUUID() + randomUUID();
  const nonce = randomUUID();
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope ?? LOGIN_SCOPE,
    state,
    nonce,
    code_challenge: await sha256Base64Url(codeVerifier),
    code_challenge_method: 'S256',
  });
  if (input.prompt) parameters.set('prompt', input.prompt);
  return { url: `${input.issuer}/authorize?${parameters.toString()}`, state, codeVerifier, nonce };
}
