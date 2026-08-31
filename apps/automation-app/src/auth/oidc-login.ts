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

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function buildAuthorizationRequest(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
}): Promise<AuthorizationRequest> {
  const state = randomUUID();
  const codeVerifier = randomUUID() + randomUUID();
  const parameters = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: LOGIN_SCOPE,
    state,
    code_challenge: await sha256Base64Url(codeVerifier),
    code_challenge_method: 'S256',
  });
  return { url: `${input.issuer}/authorize?${parameters.toString()}`, state, codeVerifier };
}
