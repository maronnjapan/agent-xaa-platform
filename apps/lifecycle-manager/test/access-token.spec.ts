import { describe, expect, it } from 'vitest';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, jwkThumbprint, signCompactJws,
  type Es256KeyPair,
} from '@xaa/crypto';
import { ISSUER, LIFECYCLE_BASE, createLifecycleHarness, seedDomain } from '../src/testing/harness.js';

/**
 * The eight checks of docs 05 §2.1, as this service applies them.
 *
 * The interesting part is not that a bad token is refused — it is *which* refusal each
 * failure earns. A token that is not this service's to accept is 401: the caller has
 * not proven who they are here. A token that is genuinely theirs but does not carry the
 * permission is 403: proven, and still not allowed. Collapsing the two would tell an
 * attacker holding a stolen token for another audience that they had merely picked the
 * wrong scope.
 */
const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

interface TokenOptions {
  aud?: string | string[];
  scope?: string;
  typ?: string;
  jkt?: string;
}

async function signAccessToken(idpKey: Es256KeyPair, dpopKey: Es256KeyPair, options: TokenOptions = {}): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: options.typ ?? 'at+jwt', kid: 'idp-testkey' },
    payload: {
      iss: ISSUER, sub: 'testuser', aud: options.aud ?? 'lifecycle-manager',
      scope: options.scope ?? 'agent:revoke', iat: issuedAt, exp: issuedAt + 3600,
      jti: `at-${Math.random().toString(36).slice(2)}`,
      cnf: { jkt: options.jkt ?? await jwkThumbprint(dpopKey.publicJwk) },
    },
    signer: createLocalEs256Signer({ privateKey: idpKey.privateKey, kid: 'idp-testkey' }),
  });
}

describe('the access token guard on the stop route', () => {
  it('rejects wrong aud / missing scope / mismatched cnf.jkt / htu mismatch / replayed jti / non at+jwt typ', async () => {
    const idpKey = await generateEs256KeyPair();
    const dpopKey = await generateEs256KeyPair();
    const otherKey = await generateEs256KeyPair();
    const harness = createLifecycleHarness({ idpPublicJwk: idpKey.publicJwk });
    await seedDomain(harness, { agentId: AGENT_ID });
    const url = `${LIFECYCLE_BASE}/agents/${AGENT_ID}/revoke`;

    const call = async (accessToken: string, proof: string): Promise<number> => (await harness.fetch(
      `/agents/${AGENT_ID}/revoke`,
      { method: 'POST', headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof } },
    )).status;

    const proofFor = async (accessToken: string, options: { keyPair?: Es256KeyPair; url?: string } = {}): Promise<string> =>
      createDpopProof({
        method: 'POST', url: options.url ?? url, keyPair: options.keyPair ?? dpopKey, accessToken,
      });

    // (2) `aud` must contain this service as an element. A token minted for the
    // Provisioner is a valid token — just not here.
    const wrongAudience = await signAccessToken(idpKey, dpopKey, { aud: ['agent-provisioner'] });
    expect(await call(wrongAudience, await proofFor(wrongAudience))).toBe(401);

    // (3) The scope is the permission, not the identity: 403, not 401.
    const withoutScope = await signAccessToken(idpKey, dpopKey, { scope: 'agent:provision' });
    expect(await call(withoutScope, await proofFor(withoutScope))).toBe(403);

    // (5) The proof is made with a key the token was never bound to — the stolen-token case.
    const boundElsewhere = await signAccessToken(idpKey, dpopKey, { jkt: await jwkThumbprint(otherKey.publicJwk) });
    expect(await call(boundElsewhere, await proofFor(boundElsewhere))).toBe(401);

    // (6) A proof made for another endpoint, replayed at this one.
    const htuMismatch = await signAccessToken(idpKey, dpopKey);
    expect(await call(htuMismatch, await proofFor(htuMismatch, { url: `${LIFECYCLE_BASE}/internal/tick` }))).toBe(401);

    // (7) The same proof twice: accepted once, refused on the replay.
    const replayed = await signAccessToken(idpKey, dpopKey);
    const proof = await proofFor(replayed);
    expect(await call(replayed, proof)).toBe(202);
    expect(await call(replayed, proof)).toBe(401);

    // (1) `typ` is checked immediately after the signature: an ID Token presented as an
    // Access Token never reaches the audience check (DEC-ID-18).
    const idToken = await signAccessToken(idpKey, dpopKey, { typ: 'JWT' });
    expect(await call(idToken, await proofFor(idToken))).toBe(401);
  });

  it('accepts a token whose aud is an array containing lifecycle-manager', async () => {
    const idpKey = await generateEs256KeyPair();
    const dpopKey = await generateEs256KeyPair();
    const harness = createLifecycleHarness({ idpPublicJwk: idpKey.publicJwk });
    await seedDomain(harness, { agentId: AGENT_ID });
    const accessToken = await signAccessToken(idpKey, dpopKey, { aud: ['authorization-platform', 'lifecycle-manager'] });
    const response = await harness.fetch(`/agents/${AGENT_ID}/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `DPoP ${accessToken}`,
        DPoP: await createDpopProof({ method: 'POST', url: `${LIFECYCLE_BASE}/agents/${AGENT_ID}/revoke`, keyPair: dpopKey, accessToken }),
      },
    });
    expect(response.status).toBe(202);
  });

  it('answers /livez with 200 and {"status":"ok"} without any token', async () => {
    const harness = createLifecycleHarness();
    const response = await harness.fetch('/livez');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
