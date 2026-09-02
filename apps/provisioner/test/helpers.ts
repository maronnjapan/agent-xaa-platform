import { webcrypto } from 'node:crypto';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { HUMAN_IDP_ISSUER, PROVISIONER_BASE, type ProvisionerHarness } from '../src/testing/harness.js';

export * from '../src/testing/harness.js';

/**
 * A Human IdP stand-in that mints the Access Token the Provisioner expects: RS256, as
 * the real Human IdP signs (its discovery builder requires an RS256 key), `at+jwt`,
 * and bound to a DPoP key the caller holds.
 *
 * Every failure case in `human-token.spec.ts` is one claim of this payload changed, so
 * the token has to be built rather than fixtured: a hand-written string would stop
 * being a valid token for a reason other than the one under test.
 */
export interface TokenIssuer {
  publicJwk: JsonWebKey;
  dpopKeyPair: Es256KeyPair;
  accessToken(overrides?: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  /** POSTs a provisioning request with the token and a matching proof. */
  provision(
    target: ProvisionerHarness,
    body: unknown,
    options?: { token?: string; omitProof?: boolean; path?: string },
  ): Promise<Response>;
}

export async function createTokenIssuer(): Promise<TokenIssuer> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const dpopKeyPair = await generateEs256KeyPair();

  const accessToken = async (
    overrides: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
  ): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: HUMAN_IDP_ISSUER,
      sub: 'testuser',
      aud: ['agent-provisioner', `${HUMAN_IDP_ISSUER}/userinfo`],
      exp: now + 300, iat: now, nbf: now, jti: `at-${Math.random().toString(36).slice(2)}`,
      scope: 'openid agent:provision', client_id: 'automation-app',
      cnf: { jkt: await jwkThumbprint(dpopKeyPair.publicJwk) },
      ...overrides,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'at+jwt', kid: 'idp-testkey', ...header })}.${encode(payload)}`;
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString('base64url')}`;
  };

  return {
    publicJwk,
    dpopKeyPair,
    accessToken,
    async provision(target, body, options = {}) {
      const path = options.path ?? '/provisioning';
      const token = options.token ?? await accessToken();
      const headers: Record<string, string> = {
        'content-type': 'application/json', Authorization: `DPoP ${token}`,
      };
      if (!options.omitProof) {
        headers.DPoP = await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}${path}`, keyPair: dpopKeyPair, accessToken: token,
        });
      }
      return target.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    },
  };
}
