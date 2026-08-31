import { describe, it, expect, beforeAll } from 'vitest';
import type { SigningKeyProvider, SigningKey } from '@maronn-openid-connect/core';
import { Hono } from 'hono';
import { exportPublicJwk } from '@maronn-openid-connect/core';
import { createApp, validateSigningKeySet } from './app.js';
import { applyOidc } from './apply.js';
import { createInMemoryClientResolver, type RegisteredClient } from './config.js';
import { accessTokenStore, authSessionStore, consentStore, createJsonProviderStores, parseSessionId, refreshTokenStore, transactionStore, type JsonStoreBackend } from './store.js';
import { consentResolver } from './resolvers.js';
import { defaultViews } from './views.js';
import { renderView } from './views.js';

/**
 * HTTP conformance smoke tests for the generated OpenID Connect Provider.
 *
 * These drive the real Hono app through app.request() so a regression in the
 * generated wiring (status / headers / JSON shape) is caught immediately —
 * e.g. a template edit or a core API signature change that breaks the contract.
 *
 * Every assertion pins a single expected value to a concrete result so a
 * regression cannot slip through a matcher that accepts a range of values.
 *
 * - Discovery exposes the mandatory provider metadata (OIDC Discovery 1.0 §3).
 * - Token error responses are uncacheable OAuth error JSON (RFC 6749 §5.2).
 * - UserInfo rejects invalid tokens with a Bearer challenge (RFC 6750 §3).
 */

const REDIRECT_URI = 'http://localhost:3000/callback';

function idTokenPayload(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1] ?? '';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))));
}

// RFC 7636 Appendix B example PKCE pair: verifier
// 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' -> this S256 challenge.
const CONFORMANCE_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/**
 * Drives authorize -> login -> consent for client 'c-conf' and returns the
 * authorization code. Pure data collection: it neither asserts nor branches, so
 * every contract check stays in the it() blocks. A step that fails to redirect
 * yields an empty code, which the caller's expect() on the token response catches.
 */
async function conformanceAuthorizationCode(scope: string): Promise<string> {
  const relativeFrom = (location: string | null): string => {
    const url = new URL(location ?? '', 'http://localhost');
    return url.pathname + url.search;
  };
  const csrfFrom = (html: string): string =>
    html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';

  const authorizeRes = await app.request(
    '/authorize?response_type=code&client_id=c-conf' +
      '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
      '&scope=' + encodeURIComponent(scope) +
      '&state=introspect-jti&prompt=consent' +
      '&code_challenge=' + CONFORMANCE_PKCE_CHALLENGE + '&code_challenge_method=S256',
  );
  const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
  // Carry forward whatever cookie /authorize set, exactly as a browser would.
  // With --enable transaction-binding this is the per-transaction binding
  // secret the later steps require; without it this is '' and the OP ignores
  // it, so the same flow works in both builds.
  const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  const transactionId =
    new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

  const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
  const loginRes = await app.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
    body: new URLSearchParams({
      transaction_id: transactionId,
      csrf_token: csrfFrom(await loginGet.text()),
      username: 'testuser',
      password: 'password',
    }).toString(),
  });

  const consentPath = relativeFrom(loginRes.headers.get('Location'));
  const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
  const consentRes = await app.request('/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
    body: new URLSearchParams({
      transaction_id: transactionId,
      csrf_token: csrfFrom(await consentGet.text()),
      action: 'approve',
    }).toString(),
  });

  return new URL(consentRes.headers.get('Location') ?? '', 'http://localhost').searchParams.get('code') ?? '';
}

const testClients = new Map<string, RegisteredClient>([
  // RFC 7591 §2: registering the refresh_token grant is what makes this client
  // eligible for refresh tokens at all, so the reuse-cascade tests can drive the
  // full code/refresh flow and observe revocation across the grant.
  ['c-conf', {
    clientId: 'c-conf',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
  ['c-public', {
    clientId: 'c-public',
    redirectUris: [REDIRECT_URI],
    clientType: 'public' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'none',
  }],
  // A confidential client registered for client_secret_basic so the conformance
  // suite can drive Authorization: Basic authentication (RFC 6749 §2.3.1).
  ['c-conf-basic', {
    clientId: 'c-conf-basic',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: 'client_secret_basic',
  }],
  // RFC 7591 §2 の既定（grant_types = ["authorization_code"]）そのままのクライアント。
  // Refresh Token を一切受け取れないこと、offline_access が付与 scope から落ちることを
  // 契約として固定するために置く。
  ['c-conf-no-refresh', {
    clientId: 'c-conf-no-refresh',
    clientSecret: 's',
    redirectUris: [REDIRECT_URI],
    clientType: 'confidential' as const,
    responseTypes: ['code'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'client_secret_post',
  }],
]);

// OIDC Core 1.0 §6.1: a signed RS256 Request Object for the conformance flow,
// built in beforeAll once the client signing key is generated.
let signedRequestObject = '';

function requestObjectB64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requestObjectB64UrlJson(value: unknown): string {
  return requestObjectB64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function buildSignedRequestObject(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
): Promise<string> {
  const signingInput =
    requestObjectB64UrlJson({ alg: 'RS256', kid, typ: 'oauth-authz-req+jwt' }) +
    '.' +
    requestObjectB64UrlJson(payload);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return signingInput + '.' + requestObjectB64Url(signature);
}

let app: ReturnType<typeof createApp>;
let appliedApp: Hono;
let signingKeyProvider: SigningKeyProvider;

beforeAll(async () => {
  // Ephemeral RS256 key so the createApp middleware can load a signing key.
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  signingKeyProvider = {
    async getSigningKey(): Promise<SigningKey> {
      return { privateKey: keyPair.privateKey, publicJwk, keyId: 'test-key' };
    },
  };

  // OIDC Core 1.0 §6.1: register a client signing key and build a signed Request
  // Object so the conformance flow can exercise request-object-by-value support.
  const requestObjectKeyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const requestObjectClient = testClients.get('c-conf');
  if (requestObjectClient) {
    requestObjectClient.jwks = {
      keys: [await exportPublicJwk(requestObjectKeyPair.publicKey, 'c-conf-req-key')],
    };
  }
  signedRequestObject = await buildSignedRequestObject(
    {
      response_type: 'code',
      client_id: 'c-conf',
      redirect_uri: REDIRECT_URI,
      scope: 'openid',
      state: 'req-obj',
    },
    requestObjectKeyPair.privateKey,
    'c-conf-req-key',
  );

  app = createApp({
    signingKeyProvider,
    clientResolver: createInMemoryClientResolver(testClients),
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),
    corsOrigins: 'https://client.example',
  });
  appliedApp = new Hono();
  applyOidc(appliedApp, {
    signingKeyProvider,
    clientResolver: createInMemoryClientResolver(testClients),
    acrResolver: async () => ({ acr: 'urn:example:loa:2', amr: ['pwd', 'otp'] }),
    corsOrigins: 'https://client.example',
  });
});

describe('generated provider HTTP conformance', () => {
  describe('Persistent storage contract', () => {
    it('should share state across provider store instances backed by the same backend', async () => {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const writerStores = createJsonProviderStores(backend);
      await writerStores.authSessionStore.set('persistent-transaction', {
        subject: 'testuser',
        authTime: 1700000000,
      });

      const readerStores = createJsonProviderStores(backend);

      expect(await readerStores.authSessionStore.get('persistent-transaction')).toEqual({
        subject: 'testuser',
        authTime: 1700000000,
      });
    });
  });


  describe('Generated view rendering', () => {
    it('should HTML-escape every login and consent value', () => {
      const hostile = '"><script>alert(1)</script>';
      const loginHtml = String(defaultViews.loginPage({
        transactionId: hostile,
        csrfToken: hostile,
        error: '<img src=x onerror=alert(1)>',
      }));
      const consentHtml = String(defaultViews.consentPage({
        transactionId: hostile,
        csrfToken: hostile,
        scopes: ['openid'],
        clientId: 'client',
      }));

      expect(loginHtml.includes('<script>')).toBe(false);
      expect(loginHtml.includes('<img src=x onerror=alert(1)>')).toBe(false);
      expect(loginHtml.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
      expect(loginHtml.includes('&lt;img src=x onerror=alert(1)&gt;')).toBe(true);
      expect(consentHtml.includes('<script>')).toBe(false);
      expect(consentHtml.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')).toBe(true);
    });

    it('should preserve a custom Response returned by a view', () => {
      const customResponse = new Response('custom view', {
        status: 202,
        headers: { 'X-View-Renderer': 'custom' },
      });
      const rendered = renderView(customResponse, { status: 400 });

      expect(rendered).toBe(customResponse);
      expect(rendered.status).toBe(202);
      expect(rendered.headers.get('X-View-Renderer')).toBe('custom');
    });

    it('should render a custom HTML string returned by the error view', async () => {
      const customHtml = '<!DOCTYPE html><p>custom authorization error</p>';
      const customApp = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        views: { errorPage: () => customHtml },
      });
      const res = await customApp.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent('http://attacker.example/cb') +
        '&scope=openid&state=custom-view' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await res.text()).toBe(customHtml);
    });
  });

  describe('Generated signing-key validation', () => {
    it('should reject an RSA signing key below 2048 bits', () => {
      const weakKey: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA', n: '_'.repeat(170) + '8', e: 'AQAB' },
        keyId: 'weak-key',
      };

      expect(() => validateSigningKeySet([weakKey])).toThrow(
        'Signing key "weak-key" has a 1024-bit RSA modulus; minimum allowed is 2048 bits (NIST SP 800-131A Rev.2)',
      );
    });

    it('should reject weak signing keys through createApp and applyOidc', async () => {
      const weakKey: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'RSA', n: '_'.repeat(170) + '8', e: 'AQAB' },
        keyId: 'weak-runtime-key',
      };
      const weakProvider: SigningKeyProvider = {
        async getSigningKey(): Promise<SigningKey> {
          return weakKey;
        },
        async getSigningKeys(): Promise<SigningKey[]> {
          return [weakKey];
        },
      };
      const createdApp = createApp({ signingKeyProvider: weakProvider });
      const mountedApp = new Hono();
      applyOidc(mountedApp, { signingKeyProvider: weakProvider });
      const responses = await Promise.all(
        [createdApp, mountedApp].map(async (targetApp) => {
          const res = await targetApp.request('/.well-known/openid-configuration');
          return { status: res.status, body: await res.json() };
        }),
      );

      expect(responses).toEqual([
        {
          status: 503,
          body: { error: 'server_error', error_description: 'Failed to load signing key' },
        },
        {
          status: 503,
          body: { error: 'server_error', error_description: 'Failed to load signing key' },
        },
      ]);
    });

    it('should reject an empty kid in a multiple-key set', () => {
      const keyWithoutKid: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: '',
      };
      const keyWithKid: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: 'second-key',
      };

      expect(() => validateSigningKeySet([keyWithoutKid, keyWithKid])).toThrow(
        'Multiple signing keys are published but a key has an empty kid (RFC 7517 §4.5)',
      );
    });

    it('should reject duplicate kid values in a multiple-key set', () => {
      const key: SigningKey = {
        privateKey: {} as CryptoKey,
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        keyId: 'duplicate-key',
      };

      expect(() => validateSigningKeySet([key, key])).toThrow(
        'Duplicate kid in signing key set: duplicate-key (RFC 7517 §4.5)',
      );
    });
  });

  describe('Discovery Endpoint', () => {
    // OIDC Discovery 1.0 §3: these members MUST be advertised so relying parties
    // can drive the Basic OP flow from metadata alone. The default issuer is
    // http://localhost:3000 (config.ts), so every endpoint URL is fully pinned.
    it('should return the required OIDC provider metadata fields', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata).toMatchObject({
        issuer: 'http://localhost:3000',
        authorization_endpoint: 'http://localhost:3000/authorize',
        token_endpoint: 'http://localhost:3000/token',
        jwks_uri: 'http://localhost:3000/.well-known/jwks.json',
        userinfo_endpoint: 'http://localhost:3000/userinfo',
        response_types_supported: ['code'],
        // OAuth 2.0 Multiple Response Type Encoding Practices §2: the code flow
        // returns the authorization response via query, so the OP advertises
        // response_modes_supported as exactly ['query'].
        response_modes_supported: ['query'],
      });
    });

    // OIDC Core 1.0 §11: offline_access must be advertised so relying parties (and
    // the OIDF Conformance Suite's oidcc-refresh-token module) request refresh
    // tokens via 'scope=openid offline_access' with prompt=consent. The full list
    // is pinned so dropping offline_access (or any scope) fails the contract.
    it('should advertise offline_access in scopes_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.scopes_supported).toEqual([
        'openid',
        'profile',
        'email',
        'address',
        'phone',
        'offline_access',
      ]);
    });

    // OIDC Core 1.0 §2 / §3.1.3.6 + Discovery 1.0 §3: claims_supported advertises
    // the claims the OP can supply, including the ID Token protocol claims
    // (auth_time/nonce/acr/amr/azp/at_hash). The full list is pinned so dropping
    // any claim fails the contract. c_hash is excluded (Hybrid is not implemented).
    it('should advertise the issuable claims in claims_supported', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.claims_supported).toEqual([
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'acr',
        'amr',
        'azp',
        'at_hash',
        'name',
        'family_name',
        'given_name',
        'middle_name',
        'nickname',
        'preferred_username',
        'profile',
        'picture',
        'website',
        'gender',
        'birthdate',
        'zoneinfo',
        'locale',
        'updated_at',
        'email',
        'email_verified',
        'address',
        'phone_number',
        'phone_number_verified',
      ]);
    });

    // OIDC Discovery 1.0 §3 / Core 1.0 §5.5: claims_parameter_supported defaults
    // to false when omitted, which makes spec-compliant RPs skip the (implemented)
    // 'claims' request parameter. It is pinned to true so a regression is caught.
    it('should advertise claims_parameter_supported as true', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.claims_parameter_supported).toBe(true);
    });

    it('should advertise the exact supported token endpoint authentication methods', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.token_endpoint_auth_methods_supported).toEqual([
        'client_secret_basic',
        'client_secret_post',
        'none',
      ]);
    });

    // RFC 8414 §3.2 / RFC 9111 §5.2: Discovery metadata is cacheable. The
    // endpoint advertises a 3600s freshness lifetime so client libraries reuse
    // the metadata deterministically, matching the JWKS endpoint (jwks.ts).
    it('should return Cache-Control public, max-age=3600 on discovery response', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    });
  });

  describe('Token Endpoint error response', () => {
    // RFC 6749 §5.2: token error responses carry a JSON body with an error
    // member and MUST set Cache-Control: no-store so error JSON is never cached.
    it('should return Cache-Control no-store and an OAuth error JSON', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // Omit grant_type so the endpoint emits an invalid_request error response.
        body: new URLSearchParams({ scope: 'openid' }).toString(),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Missing required parameter: grant_type',
      });
    });
  });

  describe('UserInfo Endpoint', () => {
    // RFC 6750 §3 / OIDC Core 1.0 §5.3.3: an invalid access token MUST be
    // rejected with 401 and an exact WWW-Authenticate Bearer challenge.
    it('should return 401 with a WWW-Authenticate Bearer challenge for an invalid token', async () => {
      const res = await app.request('/userinfo', {
        headers: { Authorization: 'Bearer this-token-does-not-exist' },
      });

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe(
        'Bearer realm="UserInfo", error="invalid_token", error_description="Access token is invalid"',
      );
    });

    it('should return only the UserInfo realm when no access token is provided', async () => {
      const res = await app.request('/userinfo');

      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
      expect(await res.json()).toEqual({
        error: 'invalid_token',
        error_description: 'Access token is required',
      });
    });

    // RFC 9068 §4: the generated OP passes its UserInfo endpoint URL to
    // validateUserInfoAudience, so aud validation is on by default for both JWT and opaque
    // tokens. Flow-issued tokens always carry the UserInfo endpoint in aud, so these inject
    // tokens with an explicit aud to exercise the accept/reject wiring end-to-end.
    describe('Access Token Audience Validation (RFC 9068 §4)', () => {
      const USERINFO_AUD = 'http://localhost:3000/userinfo';

      it('should return 200 for a token whose aud includes the UserInfo endpoint', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-ok', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: [USERINFO_AUD, 'https://api.example.com'],
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-ok' },
        });
        expect(res.status).toBe(200);
      });

      it('should accept every supported UserInfo form media type spelling', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-post-ok', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: [USERINFO_AUD],
          issuer: 'http://localhost:3000',
        });
        const contentTypes = [
          'application/x-www-form-urlencoded',
          'Application/X-WWW-Form-Urlencoded',
          'application/x-www-form-urlencoded; charset=utf-8',
        ];
        const responses = await Promise.all(
          contentTypes.map(async (contentType) => {
            const res = await app.request('/userinfo', {
              method: 'POST',
              headers: { 'Content-Type': contentType },
              body: new URLSearchParams({ access_token: 'conf-post-ok' }).toString(),
            });
            return { status: res.status, body: await res.json() };
          }),
        );

        expect(responses).toEqual([
          { status: 200, body: { sub: 'testuser' } },
          { status: 200, body: { sub: 'testuser' } },
          { status: 200, body: { sub: 'testuser' } },
        ]);
      });

      it('should return 401 for a token whose aud excludes the UserInfo endpoint', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-ng', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          audience: ['https://api.example.com'],
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-ng' },
        });
        expect(res.status).toBe(401);
      });

      it('should return 401 for a token with no stored aud (no opaque escape hatch)', async () => {
        const now = Math.floor(Date.now() / 1000);
        accessTokenStore.set('conf-aud-missing', {
          sub: 'testuser',
          clientId: 'c-conf',
          scope: ['openid'],
          expiresAt: now + 3600,
          issuer: 'http://localhost:3000',
        });
        const res = await app.request('/userinfo', {
          headers: { Authorization: 'Bearer conf-aud-missing' },
        });
        expect(res.status).toBe(401);
      });
    });
  });

  // RFC 7519 §4.1.5 / RFC 7662 §2.2: the token endpoint persists nbf (= iat) for both
  // JWT and opaque access tokens, so introspection reports a not-yet-valid token inactive
  // and echoes nbf for a valid one. Inject tokens with an explicit nbf to drive it.
  describe('Token Introspection nbf validation (RFC 7662 §2.2)', () => {
    function introspect(token: string): Promise<Response> {
      return app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token }).toString(),
      });
    }

    it('should reject a non-form introspection request before parsing the body', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'conf-nbf-ok' }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
    });

    it('should accept a case-insensitive form media type with a charset', async () => {
      const res = await app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ client_id: 'c-conf', client_secret: 's', token: 'missing' }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    });

    it('should report active=true and echo nbf for a token with a valid (past) nbf', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('conf-nbf-ok', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
        iat: now,
        nbf: now,
      });
      const res = await introspect('conf-nbf-ok');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ active: true, nbf: now });
    });

    it('should report active=false for a token whose nbf is in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('conf-nbf-future', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
        iat: now,
        nbf: now + 500,
      });
      const res = await introspect('conf-nbf-future');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ active: false });
    });

    // RFC 9068 §2.2: jti is REQUIRED for JWT access tokens; RFC 7662 §2.2 lists it
    // as a response claim. The token endpoint persists the identifier core minted
    // for the issuance, so introspection of a real token echoes it.
    it('should echo the jti of an access token issued by the token endpoint', async () => {
      const code = await conformanceAuthorizationCode('openid');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const accessToken = (await tokenRes.json()).access_token as string;

      const res = await introspect(accessToken);
      expect(res.status).toBe(200);
      const body = await res.json();

      // idTokenPayload decodes any compact JWS body; the default access token
      // format is JWT, so the stored jti must be the claim inside the token.
      const accessTokenJti = idTokenPayload(accessToken).jti;
      expect(typeof accessTokenJti).toBe('string');
      expect(body.active).toBe(true);
      expect(body.jti).toBe(accessTokenJti);
    });
  });

  describe('Authorization Endpoint non-redirect errors', () => {
    // A valid S256 challenge so the request is rejected solely on redirect_uri,
    // not on a missing PKCE parameter.
    const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const unregisteredAuthorizeUrl =
      '/authorize?response_type=code&client_id=c-conf' +
      '&redirect_uri=' + encodeURIComponent('http://attacker.example/cb') +
      '&scope=openid&state=abc' +
      '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256';

    // OIDC Core 1.0 §3.1.2.2: an unregistered redirect_uri MUST NOT be redirected
    // to. Browser callers receive an HTML error page (HTTP 400) so the OIDF
    // Conformance Suite (oidcc-ensure-registered-redirect-uri) can screenshot it.
    it('should render an HTML error page (not redirect) for an unregistered redirect_uri', async () => {
      const res = await app.request(unregisteredAuthorizeUrl);

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      const body = await res.text();
      // Pinned to the default error page so a regression in the rendered markup
      // (or a missing error_description) is caught exactly.
      expect(body).toBe(
        [
          '<!DOCTYPE html>',
          '<html>',
          '<head><title>Error</title></head>',
          '<body>',
          '  <h1>Error</h1>',
          '  <p>invalid_request</p>',
          '  <p>redirect_uri not registered</p>',
          '</body>',
          '</html>',
        ].join('\n'),
      );
    });

    // Programmatic callers that explicitly ask for JSON still receive the OAuth
    // error JSON instead of the HTML page.
    it('should return OAuth error JSON when the caller requests application/json', async () => {
      const res = await app.request(unregisteredAuthorizeUrl, {
        headers: { Accept: 'application/json' },
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'redirect_uri not registered',
      });
    });
  });

  describe('Auth transaction User-Agent binding (disabled by default)', () => {
    const NO_BINDING_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function noBindingRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function noBindingCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Drive the whole flow WITHOUT ever sending a Cookie header, exactly as a
    // curl session would. No assertions or branching in here.
    async function flowWithoutCookies(state: string): Promise<{
      authorizeSetCookie: string | null;
      loginFormStatus: number;
      consentFormStatus: number;
      consentFormHasCsrf: boolean;
      callbackCode: string;
      callbackState: string | null;
    }> {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + NO_BINDING_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = noBindingRelativeFrom(authorizeRes.headers.get('Location'));
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath);
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: noBindingCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      const consentPath = noBindingRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath);
      const consentHtml = await consentGet.text();
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: noBindingCsrfFrom(consentHtml),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return {
        authorizeSetCookie: authorizeRes.headers.get('Set-Cookie'),
        loginFormStatus: loginGet.status,
        consentFormStatus: consentGet.status,
        consentFormHasCsrf: noBindingCsrfFrom(consentHtml).length > 0,
        callbackCode: callback.searchParams.get('code') ?? '',
        callbackState: callback.searchParams.get('state'),
      };
    }

    it('should not set any binding cookie on the redirect to the login page', async () => {
      const flow = await flowWithoutCookies('no-binding-cookie');

      expect(flow.authorizeSetCookie).toBe(null);
    });

    // The whole point of leaving this off by default: transaction_id alone is
    // enough to walk the flow, so the OP can be explored by hand.
    it('should complete the whole flow without sending a single cookie', async () => {
      const flow = await flowWithoutCookies('no-binding-flow');

      expect(flow.loginFormStatus).toBe(200);
      expect(flow.consentFormStatus).toBe(200);
      expect(flow.consentFormHasCsrf).toBe(true);
      expect(flow.callbackState).toBe('no-binding-flow');
      expect(flow.callbackCode.length).toBe(43);
    });
  });

  describe('custom view rendering (ViewResult / renderView)', () => {
    // A view returning a plain HTML string is wrapped into a text/html Response.
    it('should wrap a custom HTML string view into a text/html Response', async () => {
      const res = renderView('<h1>custom-view-string</h1>');

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await res.text()).toBe('<h1>custom-view-string</h1>');
    });

    // The caller-provided status is applied to a wrapped string view (e.g. the
    // 429 rate-limit error page).
    it('should apply the provided status when wrapping a string view', async () => {
      const res = renderView('<h1>too many</h1>', { status: 429 });

      expect(res.status).toBe(429);
      expect(await res.text()).toBe('<h1>too many</h1>');
    });

    // A view returning a Response keeps full control of the HTTP response
    // (status, headers, body) — proving Views is no longer string-fixed.
    it('should pass a Response returned by a custom view through untouched', async () => {
      const original = new Response('<h1>custom-view-response</h1>', {
        status: 203,
        headers: { 'Content-Type': 'text/html; charset=UTF-8', 'X-Custom-View': 'on' },
      });
      const res = renderView(original);

      expect(res).toBe(original);
      expect(res.status).toBe(203);
      expect(res.headers.get('X-Custom-View')).toBe('on');
      expect(await res.text()).toBe('<h1>custom-view-response</h1>');
    });

    // End-to-end: the login route returns its view via renderView, so the login
    // page is delivered as a text/html Response through the framework at runtime.
    it('should deliver the login page through renderView as a text/html Response', async () => {
      // RFC 7636 Appendix B example challenge so authorize is accepted and mints a
      // transaction (302 -> /login); the verifier is never needed here.
      const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent('openid') +
        '&state=view-xyz' +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const authorizeRes = await app.request(authorizeUrl);
      const loginUrl = new URL(authorizeRes.headers.get('Location') ?? '', 'http://localhost');
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

      const res = await app.request(loginUrl.pathname + loginUrl.search, { headers: { Cookie: bindingCookie } });

      // The login body carries a dynamic transaction_id / csrf_token, so the
      // status + content type pin that renderView delivered a text/html Response
      // at runtime; the exact-body wrapping is pinned by the renderView unit tests.
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    });
  });

  describe('Internal redirect origin (OIDC Discovery 1.0 §3 / RFC 9700 §2.1)', () => {
    // RFC 7636 Appendix B example PKCE challenge.
    const REDIRECT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function issuerAuthorizeUrl(origin: string, overrides: Record<string, string> = {}): string {
      return origin + '/authorize?' + new URLSearchParams({
        response_type: 'code',
        client_id: 'c-conf',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'redirect-origin',
        code_challenge: REDIRECT_PKCE_CHALLENGE,
        code_challenge_method: 'S256',
        ...overrides,
      }).toString();
    }

    function redirectOriginCsrf(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function redirectOriginCookie(res: Response): string {
      return (res.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    }

    // Drives authorize -> login POST from an attacker origin and returns each
    // Location plus the session cookie login handed out. The transaction cookie
    // is carried forward exactly as a browser would, so this works with or
    // without --enable transaction-binding. Pure fetch-and-parse: every check
    // stays in the it() blocks as an expect().
    async function loginFromOrigin(origin: string): Promise<{
      loginRedirect: string;
      consentRedirect: string;
      sessionCookie: string;
    }> {
      const authorizeRes = await app.request(issuerAuthorizeUrl(origin), {
        headers: { Host: 'attacker.example' },
      });
      const loginRedirect = authorizeRes.headers.get('Location') ?? '';
      const bindingCookie = redirectOriginCookie(authorizeRes);
      const loginUrl = new URL(loginRedirect, 'http://localhost');
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(origin + loginUrl.pathname + loginUrl.search, {
        headers: { Cookie: bindingCookie },
      });
      const loginRes = await app.request(origin + '/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: bindingCookie,
          Host: 'attacker.example',
        },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: redirectOriginCsrf(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });

      return {
        loginRedirect,
        consentRedirect: loginRes.headers.get('Location') ?? '',
        sessionCookie: redirectOriginCookie(loginRes),
      };
    }

    it('should build the login redirect Location on the configured issuer origin', async () => {
      const res = await app.request(issuerAuthorizeUrl('http://localhost:3000'));
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.has('transaction_id')).toBe(true);
    });

    it('should ignore the Host header when building the login redirect Location', async () => {
      // Runtimes such as @hono/node-server build the request URL from the Host
      // header, so an attacker-controlled Host arrives here as an attacker-origin
      // request URL. Both are sent; neither may reach the Location.
      const res = await app.request(issuerAuthorizeUrl('http://attacker.example'), {
        headers: { Host: 'attacker.example' },
      });
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/login');
    });

    it('should build the consent redirect Location on the configured issuer origin', async () => {
      // SSO path: an established OP session makes /authorize redirect straight
      // to /consent (OIDC Core 1.0 §3.1.2.3). prompt=consent forces the consent
      // screen (OIDC Core 1.0 §3.1.2.1), so this stays on the /consent redirect
      // even when another test already recorded a consent grant in the shared
      // store. The attacker origin on this second request must not leak into
      // that Location either.
      const first = await loginFromOrigin('http://attacker.example');
      const res = await app.request(
        issuerAuthorizeUrl('http://attacker.example', { prompt: 'consent' }),
        { headers: { Cookie: first.sessionCookie, Host: 'attacker.example' } },
      );
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/consent');
    });

    it('should build the consent redirect Location on the configured issuer origin after login', async () => {
      const flow = await loginFromOrigin('http://attacker.example');
      const location = new URL(flow.consentRedirect);

      expect(new URL(flow.loginRedirect).origin).toBe('http://localhost:3000');
      expect(location.origin).toBe('http://localhost:3000');
      expect(location.pathname).toBe('/consent');
    });

    it('should keep the login redirect Location on the issuer origin for a subpath issuer', async () => {
      // '/login' is an absolute path, so a subpath issuer contributes only its
      // origin — the same result the express/fastify/nextjs adapters produce
      // when they rebase request URLs onto the issuer. Subpath mounting of the
      // generated routes is a separate, unsupported concern.
      const subpathApp = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        config: { issuer: 'https://op.example.com/op' },
      });
      const res = await subpathApp.request(issuerAuthorizeUrl('https://op.example.com'));
      const location = new URL(res.headers.get('Location') ?? '');

      expect(res.status).toBe(302);
      expect(location.origin).toBe('https://op.example.com');
      expect(location.pathname).toBe('/login');
    });
  });

  describe('HTTP method enforcement (RFC 9110 §15.5.6)', () => {
    it('should return 405 and an exact Allow header for unsupported endpoint methods', async () => {
      const cases = [
        { path: '/token', method: 'GET', allow: 'POST' },
        { path: '/userinfo', method: 'PUT', allow: 'GET, POST' },
      { path: '/introspect', method: 'GET', allow: 'POST' },
      { path: '/revoke', method: 'GET', allow: 'POST' },
        { path: '/.well-known/openid-configuration', method: 'POST', allow: 'GET' },
        { path: '/.well-known/jwks.json', method: 'POST', allow: 'GET' },
      ];
      const responses = await Promise.all(
        cases.map(async (testCase) => {
          const response = await app.request(testCase.path, { method: testCase.method });
          return { status: response.status, allow: response.headers.get('Allow') };
        }),
      );

      expect(responses).toEqual(cases.map((testCase) => ({ status: 405, allow: testCase.allow })));
    });

    // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
    // supported. RFC 9110 §9.3.2: HEAD shares GET semantics but MUST NOT return a
    // body. GET-serving endpoints therefore answer HEAD like GET with an empty body.
    it('should answer HEAD on GET endpoints with 200 and an empty body (RFC 9110 §9.1, §9.3.2)', async () => {
      const cases = ['/.well-known/openid-configuration', '/.well-known/jwks.json'];
      const responses = await Promise.all(
        cases.map(async (path) => {
          const response = await app.request(path, { method: 'HEAD' });
          return { status: response.status, body: await response.text() };
        }),
      );

      expect(responses).toEqual([
        { status: 200, body: '' },
        { status: 200, body: '' },
      ]);
    });

    // UserInfo GET requires a Bearer token, so an unauthenticated HEAD returns the
    // 401 auth challenge (with an empty body), never 405 — HEAD is supported
    // wherever GET is (RFC 9110 §9.1). The auth requirement is enforced separately.
    it('should answer HEAD on the UserInfo GET endpoint with the auth challenge, not 405', async () => {
      const response = await app.request('/userinfo', { method: 'HEAD' });

      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
    });

    it('should give createApp and applyOidc the same CORS preflight behavior', async () => {
      const responses = await Promise.all(
        [app, appliedApp].map(async (targetApp) => {
          const res = await targetApp.request('/token', {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://client.example',
              'Access-Control-Request-Method': 'POST',
            },
          });
          return {
            status: res.status,
            origin: res.headers.get('Access-Control-Allow-Origin'),
            methods: res.headers.get('Access-Control-Allow-Methods'),
          };
        }),
      );

      expect(responses).toEqual([
        {
          status: 204,
          origin: 'https://client.example',
          methods: 'POST,GET,OPTIONS',
        },
        {
          status: 204,
          origin: 'https://client.example',
          methods: 'POST,GET,OPTIONS',
        },
      ]);
    });
  });

  describe('Consent denial (RFC 6749 §4.1.2.1)', () => {
    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should return access_denied and destroy the transaction and auth session', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=deny-state&prompt=consent' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
        '&code_challenge_method=S256',
      );
      expect(authorizeRes.status).toBe(302);
      const loginUrl = new URL(authorizeRes.headers.get('Location') ?? '', 'http://localhost');
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId = loginUrl.searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginUrl.pathname + loginUrl.search, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const consentUrl = new URL(loginRes.headers.get('Location') ?? '', 'http://localhost');
      const consentGet = await app.request(consentUrl.pathname + consentUrl.search, {
        headers: { Cookie: bindingCookie },
      });
      const denyRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'deny',
        }).toString(),
      });

      expect(denyRes.status).toBe(302);
      const callback = new URL(denyRes.headers.get('Location') ?? '', 'http://localhost');
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('state')).toBe('deny-state');
      expect(callback.searchParams.get('iss')).toBe('http://localhost:3000');
      expect(callback.searchParams.get('code')).toBe(null);
      expect(callback.hash).toBe('');
      expect(await transactionStore.get('auth_txn:' + transactionId)).toBe(null);
      expect(await authSessionStore.get(transactionId)).toBeUndefined();
    });
  });

  describe('id_token_hint across prompt paths', () => {
    const HINT_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const HINT_PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    let hintSessionCookie = '';

    function hintCsrfToken(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function hintRelativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function hintB64Url(bytes: Uint8Array): string {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function hintB64UrlJson(value: unknown): string {
      return hintB64Url(new TextEncoder().encode(JSON.stringify(value)));
    }

    // Builds a hint the OP itself could have issued: signed with the ID Token
    // signing key, so the default jwksProvider (the OP's own key set) accepts it.
    // Overrides let a single case break exactly one claim (sub / aud / exp).
    async function buildIdTokenHint(overrides: Record<string, unknown> = {}): Promise<string> {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signingKey = await signingKeyProvider.getSigningKey();
      const signingInput =
        hintB64UrlJson({ alg: 'RS256', kid: signingKey.keyId, typ: 'JWT' }) +
        '.' +
        hintB64UrlJson({
          iss: 'http://localhost:3000',
          aud: 'c-conf',
          sub: 'testuser',
          iat: issuedAt,
          exp: issuedAt + 300,
          ...overrides,
        });
      const signature = await crypto.subtle.sign(
        { name: 'RSASSA-PKCS1-v1_5' },
        signingKey.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return signingInput + '.' + hintB64Url(new Uint8Array(signature));
    }

    function authorizeWithHint(state: string, hint?: string, prompt?: string): Promise<Response> {
      return app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state +
        (prompt === undefined ? '' : '&prompt=' + prompt) +
        (hint === undefined ? '' : '&id_token_hint=' + encodeURIComponent(hint)) +
        '&code_challenge=' + HINT_PKCE_CHALLENGE + '&code_challenge_method=S256',
        { headers: { Cookie: hintSessionCookie } },
      );
    }

    // Establish an OP session for testuser and a recorded consent for c-conf so
    // the SSO fast path (and prompt=none) is armed for every case below.
    beforeAll(async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=hint-setup&prompt=consent' +
        '&code_challenge=' + HINT_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = hintRelativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: hintCsrfToken(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      hintSessionCookie = loginRes.headers.get('Set-Cookie') ?? '';
      const consentPath = hintRelativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: hintCsrfToken(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
    });

    // Regression guard: adding hint verification must not change the plain SSO path.
    it('should issue an authorization code for the SSO session when no hint is sent', async () => {
      const res = await authorizeWithHint('hint-absent');
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-absent');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
    });

    it('should issue an authorization code whose ID Token sub matches a hint naming the session user', async () => {
      const res = await authorizeWithHint('hint-match', await buildIdTokenHint());
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-match');
      expect(callback.searchParams.get('error')).toBe(null);

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: HINT_PKCE_VERIFIER,
        }).toString(),
      });

      expect(tokenRes.status).toBe(200);
      expect(idTokenPayload((await tokenRes.json()).id_token as string).sub).toBe('testuser');
    });

    // The account mix-up this contract exists to prevent: session = testuser,
    // hint = another End-User. No code may be issued off the existing session.
    it('should redirect to the login screen without a code when the hint names another End-User', async () => {
      const res = await authorizeWithHint(
        'hint-mismatch',
        await buildIdTokenHint({ sub: 'otheruser' }),
      );
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(location.pathname).toBe('/login');
      expect((location.searchParams.get('transaction_id') ?? '').length).toBe(43);
      expect(location.searchParams.get('code')).toBe(null);
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should redirect to the login screen when prompt=login is sent with a mismatched hint', async () => {
      const res = await authorizeWithHint(
        'hint-prompt-login',
        await buildIdTokenHint({ sub: 'otheruser' }),
        'login',
      );
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('code')).toBe(null);
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should redirect with login_required when the hint signature is invalid without prompt', async () => {
      const hint = await buildIdTokenHint();
      const tampered =
        hint.slice(0, hint.lastIndexOf('.') + 1) + hintB64Url(new Uint8Array(256));
      const res = await authorizeWithHint('hint-badsig', tampered);
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint signature verification failed',
      );
      expect(callback.searchParams.get('state')).toBe('hint-badsig');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    it('should redirect with login_required when the hint has expired without prompt', async () => {
      const expiredAt = Math.floor(Date.now() / 1000) - 3600;
      const res = await authorizeWithHint(
        'hint-expired',
        await buildIdTokenHint({ iat: expiredAt - 300, exp: expiredAt }),
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe('id_token_hint has expired');
      expect(callback.searchParams.get('state')).toBe('hint-expired');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    it('should redirect with login_required when the hint aud names another client', async () => {
      const res = await authorizeWithHint(
        'hint-aud',
        await buildIdTokenHint({ aud: 'c-public' }),
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint aud does not match expected audience',
      );
      expect(callback.searchParams.get('state')).toBe('hint-aud');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    // prompt=none behavior is unchanged by the hoisted verification: the matching
    // hint still authenticates silently, the mismatching one still fails.
    it('should keep issuing a code for prompt=none with a hint naming the session user', async () => {
      const res = await authorizeWithHint('hint-none-match', await buildIdTokenHint(), 'none');
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('state')).toBe('hint-none-match');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length).toBe(43);
    });

    it('should keep rejecting prompt=none with login_required when the hint names another End-User', async () => {
      const res = await authorizeWithHint(
        'hint-none-mismatch',
        await buildIdTokenHint({ sub: 'otheruser' }),
        'none',
      );
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.pathname).toBe('/callback');
      expect(callback.searchParams.get('error')).toBe('login_required');
      expect(callback.searchParams.get('error_description')).toBe(
        'id_token_hint subject does not match the active session.',
      );
      expect(callback.searchParams.get('state')).toBe('hint-none-mismatch');
      expect(callback.searchParams.get('code')).toBe(null);
    });
  });

  describe('User-initiated consent withdrawal', () => {
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function relativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function introspectActive(token: string): Promise<boolean> {
      return app.request('/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          token,
        }).toString(),
      }).then(async (response) => (await response.json()).active as boolean);
    }

    it('should revoke the withdrawn client grant while preserving another client grant', async () => {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent('openid offline_access') +
        '&state=withdraw&prompt=consent' +
        '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      expect(authorizeRes.status).toBe(302);
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      expect(loginRes.status).toBe(302);
      const sessionCookie = loginRes.headers.get('Set-Cookie') ?? '';
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      expect(consentRes.status).toBe(302);
      const code = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost')
        .searchParams.get('code') ?? '';

      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: PKCE_VERIFIER,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      const accessToken = tokenBody.access_token as string;
      const refreshToken = tokenBody.refresh_token as string;

      const now = Math.floor(Date.now() / 1000);
      const otherAccessToken = 'other-client-access-token';
      accessTokenStore.set(otherAccessToken, {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
        grantId: 'other-client-grant',
      });
      consentStore.grant('testuser', 'c-public', ['openid']);
      consentStore.recordGrant('testuser', 'c-public', 'other-client-grant');

      expect(await introspectActive(accessToken)).toBe(true);
      expect(await introspectActive(otherAccessToken)).toBe(true);

      await consentResolver.revokeConsent?.('testuser', 'c-conf');

      const refreshAfter = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });
      expect(refreshAfter.status).toBe(400);
      expect((await refreshAfter.json()).error).toBe('invalid_grant');
      expect(await introspectActive(accessToken)).toBe(false);
      expect(await introspectActive(otherAccessToken)).toBe(true);
      expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false);
      expect(consentStore.hasConsent('testuser', 'c-public', ['openid'])).toBe(true);

      const promptNoneRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=withdraw-none&prompt=none' +
        '&code_challenge=' + PKCE_CHALLENGE + '&code_challenge_method=S256',
        { headers: { Cookie: sessionCookie } },
      );
      expect(promptNoneRes.status).toBe(302);
      const promptNoneCallback = new URL(
        promptNoneRes.headers.get('Location') ?? '',
        'http://localhost',
      );
      expect(promptNoneCallback.searchParams.get('error')).toBe('consent_required');
      expect(promptNoneCallback.searchParams.get('state')).toBe('withdraw-none');
      expect(promptNoneCallback.searchParams.get('code')).toBe(null);
    });
  });

  // OAuth 2.1 §4.1.2 / §4.3.1, RFC 9700 §4.13/§4.14: authorization code reuse and
  // rotated refresh-token reuse must fail AND revoke the tokens from that grant.
  // Driven over real HTTP so a regression in the consume(used-mark) contract — e.g.
  // a generated store switched to delete() — is caught as a failed cascade.
  describe('Authorization Code & Refresh Token reuse (revoke-cascade contract)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // The flow carries forward whatever cookie /authorize set, like a browser
    // would, so it passes with or without --enable transaction-binding. These
    // helpers only fetch and parse: they make no assertions and contain no
    // branching, so every check stays in the it() blocks as an expect(). Test code
    // carries no logic that could drift from the OP's behavior.
    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      // Pure extraction: a missing token yields '' and the resulting non-302 login
      // response is caught by an expect() in the it(), not by branching here.
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    function tokenRequest(fields: Record<string, string>): Promise<Response> {
      return app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          ...fields,
        }).toString(),
      });
    }

    function userinfoStatus(accessToken: string): Promise<number> {
      return app
        .request('/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } })
        .then((res) => res.status);
    }

    // Drive authorize -> login -> consent over HTTP and return every checkpoint as
    // data. The it() blocks assert the redirect statuses / paths and read .code; this
    // helper neither asserts nor branches, so the flow contract lives in the expect()s.
    async function authorizeFlow(scope: string): Promise<{
      authorizeStatus: number;
      loginPath: string;
      loginStatus: number;
      consentPath: string;
      consentStatus: number;
      code: string;
    }> {
      // prompt=consent is required so OIDC Core 1.0 §11 grants offline_access (and
      // thus a refresh token); without it the OP drops offline_access from the grant.
      const authorizeUrl =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(scope) +
        '&state=xyz&prompt=consent&acr_values=' + encodeURIComponent('urn:example:loa:2') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await app.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeFrom(loginRes.headers.get('Location'));

      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return {
        authorizeStatus: authorizeRes.status,
        loginPath,
        loginStatus: loginRes.status,
        consentPath,
        consentStatus: consentRes.status,
        code: callback.searchParams.get('code') ?? '',
      };
    }

    it('should reject authorization code reuse and revoke every token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      const accessToken = firstBody.access_token as string;
      const refreshToken = firstBody.refresh_token as string;

      expect(idTokenPayload(firstBody.id_token as string).acr).toBe('urn:example:loa:2');
      expect(idTokenPayload(firstBody.id_token as string).amr).toEqual(['pwd', 'otp']);

      // The freshly issued access token is accepted by UserInfo.
      expect(await userinfoStatus(accessToken)).toBe(200);

      // RFC 6749 §4.1.2: reusing the consumed code fails with invalid_grant.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the access token issued from the reused code is now revoked.
      expect(await userinfoStatus(accessToken)).toBe(401);

      // Cascade: the sibling refresh token from the same grant is revoked too.
      const refreshAfter = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      expect(refreshAfter.status).toBe(400);
      expect((await refreshAfter.json()).error).toBe('invalid_grant');
    });

    it('should reject rotated refresh token reuse and revoke every token from that grant', async () => {
      // authorize -> login -> consent redirects through each OP step and hands back a code.
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.authorizeStatus).toBe(302);
      expect(flow.loginPath.startsWith('/login?')).toBe(true);
      expect(flow.loginStatus).toBe(302);
      expect(flow.consentPath.startsWith('/consent?')).toBe(true);
      expect(flow.consentStatus).toBe(302);
      const code = flow.code;

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstRefresh = (await first.json()).refresh_token as string;

      // OAuth 2.1 §4.3.1: rotation issues a new access + refresh token and marks the
      // presented refresh token used.
      const rotated = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstRefresh,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();
      const rotatedAccess = rotatedBody.access_token as string;
      const rotatedRefresh = rotatedBody.refresh_token as string;
      expect(await userinfoStatus(rotatedAccess)).toBe(200);

      // Reusing the rotated-out refresh token is detected and fails.
      const reuse = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstRefresh,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      // Cascade: the rotated access + refresh token (same grant) are revoked.
      expect(await userinfoStatus(rotatedAccess)).toBe(401);
      const rotatedRefreshAfter = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: rotatedRefresh,
      });
      expect(rotatedRefreshAfter.status).toBe(400);
      expect((await rotatedRefreshAfter.json()).error).toBe('invalid_grant');
    });

    // RFC 9068 §2.2 / RFC 7519 §4.1.7: every issued access token carries its own
    // jti, so no two issuances collide. RS256 (RFC 8017 §8.2) is deterministic:
    // without jti these in-process issuances land in the same wall-clock second
    // with identical claims and produce byte-identical token strings, which
    // silently overwrite each other in the token-keyed access token store.
    it('should issue a distinct access token on rotation while keeping the ID Token identity claims', async () => {
      const flow = await authorizeFlow('openid offline_access');
      expect(flow.consentStatus).toBe(302);

      const first = await tokenRequest({
        grant_type: 'authorization_code',
        code: flow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json();

      const rotated = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: firstBody.refresh_token as string,
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await rotated.json();

      // The rotated access token must be a new secret: reusing the same string
      // would mean a leaked first token survives the refresh.
      expect(rotatedBody.access_token === firstBody.access_token).toBe(false);

      // OIDC Core 1.0 §12.2: the re-issued ID Token keeps the authentication
      // identity (iss / sub / aud / auth_time) of the original authentication.
      // The OIDF Conformance Suite CompareIdTokenClaims module pins these.
      const firstIdToken = idTokenPayload(firstBody.id_token as string);
      const rotatedIdToken = idTokenPayload(rotatedBody.id_token as string);
      expect(rotatedIdToken.iss).toBe(firstIdToken.iss);
      expect(rotatedIdToken.sub).toBe(firstIdToken.sub);
      expect(rotatedIdToken.aud).toEqual(firstIdToken.aud);
      expect(rotatedIdToken.auth_time).toBe(firstIdToken.auth_time);
      // Single-audience ID Tokens carry no azp (OIDC Core 1.0 §2), and rotation
      // must not start adding one.
      expect(firstIdToken.azp).toBe(undefined);
      expect(rotatedIdToken.azp).toBe(undefined);
    });

    it('should keep grant-scoped revocation inside one grant when two grants are issued in the same second', async () => {
      // Two complete authorization code flows for the same client, subject, scope
      // and audience. In-process they land in the same wall-clock second, which is
      // exactly the case that collided before access tokens carried a jti.
      const firstFlow = await authorizeFlow('openid offline_access');
      expect(firstFlow.consentStatus).toBe(302);
      const secondFlow = await authorizeFlow('openid offline_access');
      expect(secondFlow.consentStatus).toBe(302);

      const firstGrant = await tokenRequest({
        grant_type: 'authorization_code',
        code: firstFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(firstGrant.status).toBe(200);
      const firstAccess = (await firstGrant.json()).access_token as string;

      const secondGrant = await tokenRequest({
        grant_type: 'authorization_code',
        code: secondFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(secondGrant.status).toBe(200);
      const secondAccess = (await secondGrant.json()).access_token as string;

      expect(firstAccess === secondAccess).toBe(false);
      expect(await userinfoStatus(firstAccess)).toBe(200);
      expect(await userinfoStatus(secondAccess)).toBe(200);

      // OAuth 2.1 §4.1.2 / RFC 9700 §4.13: reusing the first code revokes the
      // first grant's tokens. The second grant must be untouched — with colliding
      // token strings the store held a single record and this cascade either
      // missed the first token or killed the second one too.
      const reuse = await tokenRequest({
        grant_type: 'authorization_code',
        code: firstFlow.code,
        redirect_uri: REDIRECT_URI,
        code_verifier: PKCE_VERIFIER,
      });
      expect(reuse.status).toBe(400);
      expect((await reuse.json()).error).toBe('invalid_grant');

      expect(await userinfoStatus(firstAccess)).toBe(401);
      expect(await userinfoStatus(secondAccess)).toBe(200);
    });
  });

  // OIDC Core 1.0 §6.1 (Passing a Request Object by Value): the generated OP verifies
  // a signed JWS Request Object against the client's registered JWKS and applies its
  // claims (which supersede the OAuth query parameters). Discovery advertises
  // request_parameter_supported = true and request_object_signing_alg_values_supported.
  // request_uri (§6.2) remains unsupported and is rejected with
  // request_uri_not_supported (§6.3). This is what the OIDF
  // oidcc-ensure-request-object-with-redirect-uri /
  // oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported
  // modules exercise. If you change this behavior, update discovery metadata and this
  // contract together.
  describe('Request Object by value (OIDC Core 1.0 §6.1)', () => {
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('should advertise request object support in discovery metadata', async () => {
      const res = await app.request('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.request_parameter_supported).toBe(true);
      expect(metadata.request_uri_parameter_supported).toBe(false);
      expect(metadata.request_object_signing_alg_values_supported).toEqual(['RS256']);
    });

    it('should accept a signed RS256 request object and start the login flow', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid' +
        '&request=' + encodeURIComponent(signedRequestObject) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      // Accepted (not an error redirect): a transaction is created and the user is
      // sent to the login page, carrying the request object's state via the txn.
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('error')).toBe(null);
    });

    it('should reject the request_uri parameter with a request_uri_not_supported redirect', async () => {
      const url =
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=req-uri' +
        '&request_uri=' + encodeURIComponent('https://client.example/req.jwt') +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';
      const res = await app.request(url);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location') ?? '', 'http://localhost');
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('error')).toBe('request_uri_not_supported');
      expect(location.searchParams.get('state')).toBe('req-uri');
    });
  });

  // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
  // 使える Refresh Token を要求する scope」と定義し、Refresh Token の利用がその用途に
  // 限られないことも明示している（"The use of Refresh Tokens is not exclusive to the
  // offline_access use case. The Authorization Server MAY grant Refresh Tokens in other
  // contexts that are beyond the scope of this specification."）。
  //
  // この生成 OP はその other contexts を online refresh token として実装する。何が
  // 発行されるかは次の 2 つで決まる。
  //
  // | grant_types に refresh_token | offline_access の付与 | 発行される Refresh Token |
  // |---|---|---|
  // | 無し | -    | 発行しない（使えない長期資格情報を配らない）|
  // | 有り | 無し | online: ログインセッションに束縛。セッションが終われば invalid_grant |
  // | 有り | 有り | offline: セッション非依存。ログアウト後も使える |
  describe('Online and offline refresh tokens (OIDC Core 1.0 §11)', () => {
    // RFC 7636 Appendix B example PKCE pair (verifier -> its S256 challenge).
    const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const PKCE_CHALLENGE_S256 = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    function relativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfFrom(html: string): string {
      return /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    }

    // 各テストが自分だけのストアを持つ provider を作る。ブラウザセッションを直接消せる
    // ので、「ログアウトしたら online refresh token が止まる」を実フロー越しに固定できる。
    function createIsolatedProvider() {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const stores = createJsonProviderStores(backend);
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: stores,
      });
      return { provider, stores };
    }

    // authorize -> login -> consent を実際に往復し、認可コードと、そのログインで確立した
    // セッション id を返す。sessionId はログアウトを再現するために使う。
    async function authorize(
      provider: ReturnType<typeof createApp>,
      options: { clientId: string; scope: string; prompt?: string },
    ): Promise<{ code: string; sessionId: string }> {
      const authorizeUrl =
        '/authorize?response_type=code&client_id=' + options.clientId +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=' + encodeURIComponent(options.scope) +
        '&state=online-rt' +
        (options.prompt === undefined ? '' : '&prompt=' + options.prompt) +
        '&code_challenge=' + PKCE_CHALLENGE_S256 + '&code_challenge_method=S256';

      const authorizeRes = await provider.request(authorizeUrl);
      const loginPath = relativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would
      // (the per-transaction binding secret when that feature is enabled).
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await provider.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await provider.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      // /login sets exactly one cookie: the browser (OP) session. Its value is the
      // session an online refresh token gets bound to.
      const sessionId = parseSessionId(loginRes.headers.get('Set-Cookie')) ?? '';

      const consentPath = relativeFrom(loginRes.headers.get('Location'));
      const consentGet = await provider.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await provider.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');

      return { code: callback.searchParams.get('code') ?? '', sessionId };
    }

    async function exchangeCode(
      provider: ReturnType<typeof createApp>,
      clientId: string,
      code: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: PKCE_VERIFIER,
          client_id: clientId,
          client_secret: 's',
        }).toString(),
      });
    }

    async function refresh(
      provider: ReturnType<typeof createApp>,
      clientId: string,
      refreshToken: string,
    ): Promise<Response> {
      return provider.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: 's',
        }).toString(),
      });
    }

    it('should issue a refresh token without offline_access when the client registers the refresh_token grant', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });

      const res = await exchangeCode(provider, 'c-conf', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(typeof body.refresh_token).toBe('string');
      // offline_access は要求していないので付与 scope にも入らない。
      expect(body.scope).toBe('openid');
    });

    it('should keep the online refresh token usable while the login session is alive', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid');
    });

    it('should reject the online refresh token after the login session ended', async () => {
      const { provider, stores } = createIsolatedProvider();
      const { code, sessionId } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      // ログアウト相当: ブラウザ (OP) セッションを終了させる。
      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    });

    it('should keep the online refresh token bound to the session across rotation', async () => {
      const { provider, stores } = createIsolatedProvider();
      const { code, sessionId } = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      // 1 回ローテーションしても束縛は外れない（外れると 1 リフレッシュで offline 化する）。
      const rotated = await (await refresh(provider, 'c-conf', issued.refresh_token as string)).json();
      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', rotated.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_grant');
    });

    it('should keep the offline refresh token usable after the login session ended', async () => {
      const { provider, stores } = createIsolatedProvider();
      // OIDC Core 1.0 §11: offline_access needs prompt=consent.
      const { code, sessionId } = await authorize(provider, {
        clientId: 'c-conf',
        scope: 'openid offline_access',
        prompt: 'consent',
      });
      const issued = await (await exchangeCode(provider, 'c-conf', code)).json();

      await stores.browserSessionStore.delete(sessionId);

      const res = await refresh(provider, 'c-conf', issued.refresh_token as string);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid offline_access');
    });

    it('should not issue a refresh token to a client that does not register the refresh_token grant', async () => {
      // RFC 7591 §2: grant_types の既定は ["authorization_code"]。発行しても
      // unauthorized_client で拒否されるだけの Refresh Token は配らない。
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, { clientId: 'c-conf-no-refresh', scope: 'openid' });

      const res = await exchangeCode(provider, 'c-conf-no-refresh', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.refresh_token).toBe(undefined);
    });

    it('should drop offline_access for a client that does not register the refresh_token grant', async () => {
      const { provider } = createIsolatedProvider();
      const { code } = await authorize(provider, {
        clientId: 'c-conf-no-refresh',
        scope: 'openid offline_access',
        prompt: 'consent',
      });

      const res = await exchangeCode(provider, 'c-conf-no-refresh', code);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scope).toBe('openid');
      expect(body.refresh_token).toBe(undefined);
    });

    it('should issue only offline refresh tokens when onlineRefreshTokenEnabled is false', async () => {
      const values = new Map<string, unknown>();
      const backend: JsonStoreBackend = {
        async get<T>(key: string): Promise<T | null> {
          return (values.get(key) as T | undefined) ?? null;
        },
        async put<T>(key: string, value: T): Promise<void> {
          values.set(key, value);
        },
        async delete(key: string): Promise<void> {
          values.delete(key);
        },
        async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
          return [...values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: value as T }));
        },
      };
      const provider = createApp({
        signingKeyProvider,
        clientResolver: createInMemoryClientResolver(testClients),
        storage: createJsonProviderStores(backend),
        config: { onlineRefreshTokenEnabled: false },
      });

      const online = await authorize(provider, { clientId: 'c-conf', scope: 'openid' });
      const onlineBody = await (await exchangeCode(provider, 'c-conf', online.code)).json();
      expect(onlineBody.refresh_token).toBe(undefined);

      const offline = await authorize(provider, {
        clientId: 'c-conf',
        scope: 'openid offline_access',
        prompt: 'consent',
      });
      const offlineBody = await (await exchangeCode(provider, 'c-conf', offline.code)).json();
      expect(typeof offlineBody.refresh_token).toBe('string');
    });
  });


  describe('Token Revocation Endpoint (RFC 7009)', () => {
    it('should reject a non-form revocation request before parsing the body', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'public-token' }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
    });

    it('should allow a public client to revoke its own token with client_id only', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('public-token', {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'Application/X-WWW-Form-Urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ client_id: 'c-public', token: 'public-token' }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(accessTokenStore.get('public-token')).toBeUndefined();
    });

    it('should preserve a confidential client revocation', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('confidential-own-token', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-conf',
          client_secret: 's',
          token: 'confidential-own-token',
        }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(accessTokenStore.get('confidential-own-token')).toBeUndefined();
    });

    it('should let a public client revoke its refresh token and cascade the grant access tokens', async () => {
      const now = Math.floor(Date.now() / 1000);
      refreshTokenStore.set('public-refresh-token', {
        subject: 'testuser',
        clientId: 'c-public',
        scope: ['openid', 'offline_access'],
        expiresAt: now + 3600,
        used: false,
        grantId: 'public-refresh-grant',
        originalIssuedAt: now,
        authTime: now,
      });
      accessTokenStore.set('public-grant-access-token', {
        sub: 'testuser',
        clientId: 'c-public',
        scope: ['openid'],
        expiresAt: now + 3600,
        grantId: 'public-refresh-grant',
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'c-public',
          token: 'public-refresh-token',
          token_type_hint: 'refresh_token',
        }).toString(),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(refreshTokenStore.get('public-refresh-token')).toBeUndefined();
      expect(accessTokenStore.get('public-grant-access-token')).toBeUndefined();
    });

    it('should reject a public revocation request without client_id', async () => {
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: 'public-token' }).toString(),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'invalid_client',
        error_description: 'Client authentication required',
      });
    });

    it('should reject a public client revoking another client token', async () => {
      const now = Math.floor(Date.now() / 1000);
      accessTokenStore.set('confidential-token', {
        sub: 'testuser',
        clientId: 'c-conf',
        scope: ['openid'],
        expiresAt: now + 3600,
      });
      const res = await app.request('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-public', token: 'confidential-token' }).toString(),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_grant',
        error_description: 'Token was not issued to the requesting client',
      });
      expect(accessTokenStore.get('confidential-token')?.clientId).toBe('c-conf');
    });
  });
  describe('Token Endpoint client authentication methods', () => {
    function relativeLocation(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function csrfTokenFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    it('should authenticate a public token request with client_id only', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-public' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=public-auth' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: 'c-public',
        }).toString(),
      });

      expect(authorizeRes.status).toBe(302);
      expect(new URL(loginPath, 'http://localhost').pathname).toBe('/login');
      expect(loginRes.status).toBe(302);
      expect(new URL(consentPath, 'http://localhost').pathname).toBe('/consent');
      expect(consentRes.status).toBe(302);
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('openid');
      expect((tokenBody.access_token as string).split('.')).toHaveLength(3);
      expect((tokenBody.id_token as string).split('.')).toHaveLength(3);
    });

    // RFC 6749 §2.3 / §3.2.1: many OAuth client libraries always add client_id to
    // the request body even when authenticating via Authorization: Basic. A bare
    // client_id (no client_secret) is an identifier, not a second authentication
    // method, so the token exchange MUST succeed rather than fail as multiple methods.
    it('should authenticate a client_secret_basic request that also repeats client_id in the body', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf-basic' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=basic-redundant-id' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // client_secret_basic credentials (RFC 6749 §2.3.1: base64(client_id:client_secret)).
          Authorization: 'Basic ' + btoa('c-conf-basic:s'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          // Redundant identifier: present in the body without a client_secret.
          client_id: 'c-conf-basic',
        }).toString(),
      });

      expect(authorizeRes.status).toBe(302);
      expect(consentRes.status).toBe(302);
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.scope).toBe('openid');
      expect((tokenBody.access_token as string).split('.')).toHaveLength(3);
      expect((tokenBody.id_token as string).split('.')).toHaveLength(3);
    });

    it('should reject a client_secret_basic request whose body client_id contradicts the header', async () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf-basic' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=basic-mismatched-id' +
        '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256',
      );
      const loginPath = relativeLocation(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const bindingCookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';
      const loginGet = await app.request(loginPath, { headers: { Cookie: bindingCookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = relativeLocation(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: bindingCookie } });
      const consentRes = await app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingCookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: csrfTokenFrom(await consentGet.text()),
          action: 'approve',
        }).toString(),
      });
      const callback = new URL(consentRes.headers.get('Location') ?? '', 'http://localhost');
      const tokenRes = await app.request('/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa('c-conf-basic:s'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          // Contradicts the Basic header subject: a client misconfiguration.
          client_id: 'c-public',
        }).toString(),
      });

      expect(tokenRes.status).toBe(400);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.error).toBe('invalid_request');
    });
  });


  // The device authorization grant is disabled in this generated provider: no
  // endpoint, no metadata, and the URN stays an unsupported grant. These pin the
  // default-off contract so enabling the feature by accident is visible.
  describe('Device Authorization Grant disabled (RFC 8628)', () => {
    it('should not serve a device authorization endpoint', async () => {
      const res = await app.request('/device_authorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'c-conf', scope: 'openid' }).toString(),
      });

      expect(res.status).toBe(404);
    });

    it('should not serve the device verification UI', async () => {
      const res = await app.request('/device');

      expect(res.status).toBe(404);
    });

    it('should reject the device_code grant with unsupported_grant_type', async () => {
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: 'anything',
          client_id: 'c-conf',
          client_secret: 's',
        }).toString(),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('unsupported_grant_type');
    });

    it('should not advertise device authorization metadata', async () => {
      const res = await app.request('/.well-known/openid-configuration');
      const metadata = await res.json();

      expect(metadata.device_authorization_endpoint).toBeUndefined();
    });

    it('should not advertise the device_code grant type', async () => {
      const res = await app.request('/.well-known/openid-configuration');
      const metadata = await res.json();

      expect(
        (metadata.grant_types_supported as string[]).includes(
          'urn:ietf:params:oauth:grant-type:device_code',
        ),
      ).toBe(false);
    });
  });

  describe('Consent decision value (OIDC Core 1.0 §3.1.2.4)', () => {
    const DECISION_PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    // Pure fetch + parse helpers: no assertions and no branching, so the contract
    // stays visible in the it() blocks.
    function decisionRelativeFrom(location: string | null): string {
      const url = new URL(location ?? '', 'http://localhost');
      return url.pathname + url.search;
    }

    function decisionCsrfFrom(html: string): string {
      return html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
    }

    // Drives authorize -> login -> GET /consent and returns everything the browser
    // holds at the consent screen, so each test only differs in the posted action.
    async function reachConsent(state: string): Promise<{
      transactionId: string;
      csrfToken: string;
      cookie: string;
    }> {
      const authorizeRes = await app.request(
        '/authorize?response_type=code&client_id=c-conf' +
        '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
        '&scope=openid&state=' + state + '&prompt=consent' +
        '&code_challenge=' + DECISION_PKCE_CHALLENGE + '&code_challenge_method=S256',
      );
      const loginPath = decisionRelativeFrom(authorizeRes.headers.get('Location'));
      // Carry forward whatever cookie /authorize set, exactly as a browser would.
      // With --enable transaction-binding this is the per-transaction binding
      // secret the later steps require; without it this is '' and the OP ignores
      // it, so the same flow works in both builds.
      const cookie = (authorizeRes.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      const transactionId =
        new URL(loginPath, 'http://localhost').searchParams.get('transaction_id') ?? '';

      const loginGet = await app.request(loginPath, { headers: { Cookie: cookie } });
      const loginRes = await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({
          transaction_id: transactionId,
          csrf_token: decisionCsrfFrom(await loginGet.text()),
          username: 'testuser',
          password: 'password',
        }).toString(),
      });
      const consentPath = decisionRelativeFrom(loginRes.headers.get('Location'));
      const consentGet = await app.request(consentPath, { headers: { Cookie: cookie } });

      return { transactionId, csrfToken: decisionCsrfFrom(await consentGet.text()), cookie };
    }

    // The body is passed in whole so a test can leave 'action' out entirely
    // without this helper branching on it.
    function postConsent(cookie: string, body: Record<string, string>): Promise<Response> {
      return app.request('/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams(body).toString(),
      });
    }

    // A form rebuilt by a script or a test harness carries no submit-button value.
    it('should not issue an authorization code when the consent POST omits the action parameter', async () => {
      const flow = await reachConsent('decision-omitted');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    it('should not issue an authorization code when the consent POST sends an empty action value', async () => {
      const flow = await reachConsent('decision-empty');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: '',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // The realistic regression: the Approve button is renamed in views.ts, so the
    // handler receives a value it never agreed to accept.
    it('should not issue an authorization code when the consent POST sends an unknown action value', async () => {
      const flow = await reachConsent('decision-unknown');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'allow',
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('Location')).toBe(null);
    });

    // OIDC Core 1.0 §3.1.2.6: access_denied means the End-User denied the request.
    // "No decision was obtained" is a different outcome, so it stops at the OP with
    // its own error page instead of being redirected to the client.
    it('should return 400 for a consent POST with an unrecognized action value', async () => {
      const flow = await reachConsent('decision-400');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'accept',
      });
      const body = await res.text();

      expect(res.status).toBe(400);
      expect(body.includes('Invalid consent decision. Please use the Approve or Deny button.')).toBe(true);
      expect(body.includes('access_denied')).toBe(false);
    });

    it('should issue an authorization code when the consent POST sends action=approve', async () => {
      const flow = await reachConsent('decision-approve');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'approve',
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('state')).toBe('decision-approve');
      expect(callback.searchParams.get('error')).toBe(null);
      expect((callback.searchParams.get('code') ?? '').length > 0).toBe(true);
    });

    it('should redirect with error=access_denied when the consent POST sends action=deny', async () => {
      const flow = await reachConsent('decision-deny');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'deny',
      });
      const callback = new URL(res.headers.get('Location') ?? '', 'http://localhost');

      expect(res.status).toBe(302);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('error')).toBe('access_denied');
      expect(callback.searchParams.get('state')).toBe('decision-deny');
      expect(callback.searchParams.get('code')).toBe(null);
    });

    // Consent must not be persisted either: a recorded consent would let a later
    // prompt=none request succeed without the End-User ever having approved.
    it('should not record consent via recordConsent when the action value is unrecognized', async () => {
      await consentResolver.revokeConsent?.('testuser', 'c-conf');
      const flow = await reachConsent('decision-no-record');

      const res = await postConsent(flow.cookie, {
        transaction_id: flow.transactionId,
        csrf_token: flow.csrfToken,
        action: 'approved',
      });

      expect(res.status).toBe(400);
      expect(consentStore.hasConsent('testuser', 'c-conf', ['openid'])).toBe(false);
    });
  });
});
