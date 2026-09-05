import { createHash, randomBytes } from 'node:crypto';

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export interface PkcePair { verifier: string; challenge: string }

export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function formInput(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) ?? html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`));
  if (!match) throw new Error(`form field ${name} not found`);
  return match[1]!;
}

function locationOf(response: Response): string {
  const location = response.headers.get('location');
  if (!location) throw new Error(`expected a redirect, got ${response.status}`);
  return location;
}

export interface AuthorizeResult {
  /** Set when the flow reached the client redirect. */
  code?: string;
  error?: string;
  errorDescription?: string;
  state?: string;
  cookie: string;
  location: string;
}

export interface AuthorizeOptions {
  fetch: Fetcher;
  clientId: string;
  redirectUri: string;
  scope: string;
  issuer: string;
  audience?: string;
  prompt?: string;
  state?: string;
  cookie?: string;
  /** Skip the login page when an SSO cookie should be enough. */
  credentials?: { username: string; password: string };
}

/**
 * Drives the browser half of the authorization code flow with no browser:
 * /authorize -> /login -> /consent -> client redirect. Everything is form posts and
 * redirects, which is exactly what a browser would do.
 */
export async function authorize(options: AuthorizeOptions): Promise<AuthorizeResult & { pkce: PkcePair }> {
  const pkce = createPkce();
  const state = options.state ?? randomBytes(8).toString('hex');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scope,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });
  if (options.audience) query.set('audience', options.audience);
  if (options.prompt) query.set('prompt', options.prompt);

  const walked = await followAuthorizeUrl({
    fetch: options.fetch,
    url: `/authorize?${query.toString()}`,
    issuer: options.issuer,
    redirectUri: options.redirectUri,
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  return { ...walked, pkce };
}

export interface FollowAuthorizeOptions {
  fetch: Fetcher;
  /** The authorization request, as the client built it. */
  url: string;
  issuer: string;
  /** Stops the walk early when the OP redirects straight back to the client. */
  redirectUri?: string;
  cookie?: string;
  credentials?: { username: string; password: string };
}

/**
 * The same walk for a URL somebody else built. The offline_access consent starts at a
 * URL the Agent OP composed (`buildAuthorizeUrl`), so a test that rebuilds the query
 * here would be checking its own arithmetic rather than the Agent OP's.
 */
export async function followAuthorizeUrl(options: FollowAuthorizeOptions): Promise<AuthorizeResult> {
  let cookie = options.cookie ?? '';
  const headers = () => (cookie ? { cookie } : undefined);
  const done = (location: string) => Boolean(options.redirectUri && location.startsWith(options.redirectUri));

  let response = await options.fetch(pathOf(options.url, options.issuer), { headers: headers(), redirect: 'manual' });
  if (response.status >= 400) {
    const location = response.headers.get('location') ?? '';
    return { ...parseRedirect(location), cookie, location };
  }
  let location = locationOf(response);
  if (done(location)) return { ...parseRedirect(location), cookie, location };

  if (location.includes('/login')) {
    const loginPage = await options.fetch(pathOf(location, options.issuer), { headers: headers() });
    const html = await loginPage.text();
    const credentials = options.credentials ?? { username: 'testuser', password: 'password' };
    response = await options.fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams({
        transaction_id: formInput(html, 'transaction_id'),
        csrf_token: formInput(html, 'csrf_token'),
        username: credentials.username,
        password: credentials.password,
      }).toString(),
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    location = locationOf(response);
  }

  if (location.includes('/consent')) {
    const consentPage = await options.fetch(pathOf(location, options.issuer), { headers: headers() });
    const html = await consentPage.text();
    response = await options.fetch('/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams({
        transaction_id: formInput(html, 'transaction_id'),
        csrf_token: formInput(html, 'csrf_token'),
        action: 'approve',
      }).toString(),
      redirect: 'manual',
    });
    location = locationOf(response);
  }

  return { ...parseRedirect(location), cookie, location };
}

function pathOf(location: string, issuer: string): string {
  return location.startsWith('http') ? location.slice(new URL(issuer).origin.length) : location;
}

function parseRedirect(location: string): Omit<AuthorizeResult, 'cookie' | 'location'> {
  const url = new URL(location, 'https://placeholder.test');
  const code = url.searchParams.get('code') ?? undefined;
  const error = url.searchParams.get('error') ?? undefined;
  return {
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    ...(url.searchParams.get('error_description') ? { errorDescription: url.searchParams.get('error_description')! } : {}),
    ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}),
  };
}

export function basicAuth(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function decodeJwtHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export interface TokenRequestOptions {
  fetch: Fetcher;
  clientId: string;
  clientSecret: string;
  issuer: string;
  form: Record<string, string>;
  /** Attach a DPoP proof for this key pair; required for Control Plane audiences. */
  dpop?: { createProof(method: string, url: string): Promise<string> };
  /** Reuse a proof verbatim, to exercise replay rejection. */
  rawProof?: string;
}

export async function tokenRequest(options: TokenRequestOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    authorization: basicAuth(options.clientId, options.clientSecret),
  };
  const proof = options.rawProof ?? (options.dpop ? await options.dpop.createProof('POST', `${options.issuer}/token`) : undefined);
  if (proof) headers.dpop = proof;
  return options.fetch('/token', { method: 'POST', headers, body: new URLSearchParams(options.form).toString() });
}
