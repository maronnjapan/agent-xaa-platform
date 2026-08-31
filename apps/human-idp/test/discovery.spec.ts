import { describe, expect, it } from 'vitest';
import { SUPPORTED_SCOPES } from '../src/config/scopes.js';
import { createTestApp, testEnv } from './helpers.js';

async function metadata(profile: 'direct' | 'loadbalancer') {
  const app = await createTestApp({ issuerProfile: profile });
  const response = await app.fetch('/.well-known/openid-configuration');
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

describe('discovery document', () => {
  it('advertises identity_chaining only in loadbalancer profile', async () => {
    expect(await metadata('direct')).not.toHaveProperty('identity_chaining_requested_token_types_supported');
    expect((await metadata('loadbalancer')).identity_chaining_requested_token_types_supported)
      .toEqual(['urn:ietf:params:oauth:token-type:id-jag']);
  });

  it('points jwks_uri at the shared bucket object', async () => {
    expect((await metadata('direct')).jwks_uri).toBe(`${testEnv.jwksPublicBaseUrl}/jwks.json`);
  });

  it('echoes the configured issuer byte for byte', async () => {
    expect((await metadata('direct')).issuer).toBe(testEnv.issuer);
  });

  it('has no registration_endpoint and no grant profile advertisement', async () => {
    const document = await metadata('direct');
    expect(document).not.toHaveProperty('registration_endpoint');
    expect(document).not.toHaveProperty('authorization_grant_profiles_supported');
  });

  it('advertises the six registered scopes in order', async () => {
    expect((await metadata('direct')).scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });

  it('advertises only authorization_code and refresh_token grants', async () => {
    expect((await metadata('direct')).grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });
});
