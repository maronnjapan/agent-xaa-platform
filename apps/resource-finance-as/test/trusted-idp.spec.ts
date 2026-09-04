import { describe, expect, it } from 'vitest';
import { createTrustedIdpResolver, filterIdJagKeys } from '../src/config/trusted-idp.js';
import { loadResourceAsEnv } from '../src/config/env.js';
import { asEnv, createRedeemableAs } from './helpers.js';

const jwks = {
  keys: [
    { kty: 'EC', kid: 'idp-abcdefgh' },
    { kty: 'EC', kid: 'op-shared-1' },
    { kty: 'EC', kid: 'idjag-abcdefghijkl-1' },
    { kty: 'RSA', kid: 'fin-as-12345678' },
  ],
};

describe('trusted identity provider', () => {
  it('fetches the JWK Set from the configured URI', async () => {
    const seen: string[] = [];
    const resolver = createTrustedIdpResolver({
      issuer: asEnv.trustedIdpIssuer, jwksUri: asEnv.trustedIdpJwksUri,
      fetchImpl: (async (input: string) => { seen.push(String(input)); return Response.json(jwks); }) as unknown as typeof fetch,
    });
    await resolver();
    expect(seen).toEqual([asEnv.trustedIdpJwksUri]);
  });

  it('keeps only the ID-JAG signing prefixes', () => {
    expect(filterIdJagKeys(jwks as never).keys.map((key) => key.kid)).toEqual(['op-shared-1', 'idjag-abcdefghijkl-1']);
  });

  it('caches for 300 seconds so two verifications cost one fetch', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const resolver = createTrustedIdpResolver({
      issuer: asEnv.trustedIdpIssuer, jwksUri: asEnv.trustedIdpJwksUri,
      fetchImpl: (async () => { calls += 1; return Response.json(jwks); }) as unknown as typeof fetch,
      now: () => clock,
    });
    await resolver();
    await resolver();
    expect(calls).toBe(1);
    clock += 300_001;
    await resolver();
    expect(calls).toBe(2);
  });

  it('refuses an ID-JAG signed with a key outside the ID-JAG prefixes', async () => {
    // The key really is in the published set, under the Human IdP's SSO prefix.
    // Filtering it out is what stops an SSO key from standing in for an Agent OP key.
    const chain = await createRedeemableAs({}, {}, 'idp-abcdefgh');
    const response = await chain.redeem();
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('refuses an ID-JAG signed with this AS\'s own key prefix', async () => {
    const chain = await createRedeemableAs({}, {}, 'fin-as-12345678');
    expect((await (await chain.redeem()).json() as { error: string }).error).toBe('invalid_grant');
  });

  it('refuses to start without the trusted issuer configured', () => {
    const complete: NodeJS.ProcessEnv = {
      ISSUER: asEnv.issuer, TRUSTED_IDP_ISSUER: asEnv.trustedIdpIssuer, TRUSTED_IDP_JWKS_URI: asEnv.trustedIdpJwksUri,
      REGISTERED_SCOPES: 'finance.tx.read finance.tx.write', SIGNING_KEY_BUCKET: 'b', SIGNING_KEY_OBJECT: 'resource-as-signing/finance/current.json', SIGNING_KEY_KMS_KEY: 'k',
      JWKS_BUCKET: 'j', JWKS_KEY_PREFIX: 'fin-as', RESOURCE: asEnv.resourceUri,
    };
    expect(() => loadResourceAsEnv(complete)).not.toThrow();
    expect(() => loadResourceAsEnv({ ...complete, TRUSTED_IDP_ISSUER: undefined })).toThrow();
    expect(() => loadResourceAsEnv({ ...complete, TRUSTED_IDP_JWKS_URI: undefined })).toThrow();
    expect(() => loadResourceAsEnv({ ...complete, SIGNING_KEY_OBJECT: undefined })).toThrow('SIGNING_KEY_OBJECT');
  });

  it('refuses to start when the registered scopes are widened', () => {
    const complete: NodeJS.ProcessEnv = {
      ISSUER: asEnv.issuer, TRUSTED_IDP_ISSUER: asEnv.trustedIdpIssuer, TRUSTED_IDP_JWKS_URI: asEnv.trustedIdpJwksUri,
      REGISTERED_SCOPES: 'finance.tx.read finance.admin', SIGNING_KEY_BUCKET: 'b', SIGNING_KEY_OBJECT: 'resource-as-signing/finance/current.json', SIGNING_KEY_KMS_KEY: 'k',
      JWKS_BUCKET: 'j', JWKS_KEY_PREFIX: 'fin-as', RESOURCE: asEnv.resourceUri,
    };
    expect(() => loadResourceAsEnv(complete)).toThrow('invalid_registered_scope');
  });
});
