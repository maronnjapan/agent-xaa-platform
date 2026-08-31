import { afterEach, describe, expect, it } from 'vitest';
import { generateEs256KeyPair, sha256Base64Url, decodeJwsUnverified } from '@xaa/crypto';
import { createHttpClient, resetTransportForTesting, setTransport } from '../src/http-client.js';
import type { PlatformEndpoints } from '../src/schema/platform-endpoints.schema.js';

const endpoints = {
  issuer: 'https://human-idp.test',
  jwks_url: 'https://jwks.test/jwks.json',
  xaa_token_url: 'https://agent-op.test',
  xaa_callback_url: 'https://agent-op-callback.test',
  subject_token_url: 'https://agent-op.test/xaa/subject-token',
  authorization_url: 'https://authorization.test',
  provisioner_url: 'https://provisioner.test',
  lifecycle_url: 'https://lifecycle.test',
  resource_docs_as_issuer: 'https://docs-as.test',
  resource_docs_api_url: 'https://docs-api.test',
  resource_finance_as_issuer: 'https://finance-as.test',
  resource_finance_api_url: 'https://finance-api.test',
  stub_saas_op_issuer: 'https://stub-saas-op.test',
  agent_max_lifetime_seconds: 86_400,
  vertex_model: 'gemini-2.5-flash',
  vertex_location: 'us-central1',
  enable_google_bridge: false,
} as unknown as PlatformEndpoints;

afterEach(() => resetTransportForTesting());

describe('httpClient', () => {
  it('resolves base url from platform endpoints and rejects unavailable services', async () => {
    const seen: string[] = [];
    const client = createHttpClient({ endpoints, transport: async (_id, request) => { seen.push(request.url); return new Response('ok'); } });
    await client.request('provisioner', '/provisioning', { method: 'POST' });
    expect(seen[0]).toBe('https://provisioner.test/provisioning');
    await expect(client.request('google-bridge', '/token')).rejects.toThrow('endpoint unavailable: google-bridge');
  });

  it('attaches DPoP proof and DPoP scheme', async () => {
    const keyPair = await generateEs256KeyPair();
    const accessToken = 'access-token-value';
    let captured: Request | undefined;
    const client = createHttpClient({
      endpoints,
      dpop: { accessToken, keyPair },
      transport: async (_id, request) => { captured = request; return new Response('ok'); },
    });
    await client.request('resource-docs-api', '/documents');
    expect(captured?.headers.get('Authorization')).toBe(`DPoP ${accessToken}`);
    const proof = captured?.headers.get('DPoP') ?? '';
    expect(decodeJwsUnverified(proof).payload.ath).toBe(await sha256Base64Url(accessToken));
    expect(decodeJwsUnverified(proof).payload.htu).toBe('https://docs-api.test/documents');
  });

  it('setTransport can only be installed once', () => {
    setTransport(async () => new Response('ok'));
    expect(() => setTransport(async () => new Response('ok'))).toThrow('transport already set');
  });

  it('uses the installed transport when none is passed in', async () => {
    let hit = 0;
    setTransport(async () => { hit += 1; return new Response('ok'); });
    await createHttpClient({ endpoints }).request('authorization', '/v1/authorization/decisions');
    expect(hit).toBe(1);
  });
});
