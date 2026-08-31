import { createHash, randomBytes } from 'node:crypto';

export interface ConsentState {
  state: string;
  code_verifier: string;
  transaction_id: string;
  expire_at: unknown;
}

/**
 * REQ-05-047. PKCE is unconditional; there is no branch that omits it. `state` is a
 * fresh 256-bit random value stored against the transaction, never the transaction
 * id itself, so the callback cannot be forged by guessing an id.
 */
export function buildAuthorizeUrl(options: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}): string {
  const url = new URL(options.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', 'openid offline_access');
  url.searchParams.set('state', options.state);
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', createHash('sha256').update(options.codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function newConsentSecrets(): { state: string; codeVerifier: string } {
  return { state: randomBytes(32).toString('base64url'), codeVerifier: randomBytes(32).toString('base64url') };
}
