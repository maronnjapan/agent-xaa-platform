import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint } from '@xaa/crypto';
import { AGENT_OP_BASE, createFixture, exchange } from './helpers.js';

describe('DPoP on the token endpoints', () => {
  it('rejects a request without a DPoP header', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { omitProof: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('rejects an htu mismatch', async () => {
    const fixture = await createFixture();
    const proof = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/subject-token`, keyPair: fixture.dpopKeyPair, now: fixture.now });
    const response = await exchange(fixture, { proof });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('rejects a replayed jti', async () => {
    const fixture = await createFixture();
    const proof = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: fixture.dpopKeyPair, now: fixture.now });
    expect((await exchange(fixture, { proof })).status).toBe(200);
    const second = await exchange(fixture, { proof });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'invalid_dpop_proof' });
    expect(fixture.events.some((event) => event.detail.violation_code === 'replayed_dpop_proof')).toBe(true);
  });

  it('rejects a proof carrying ath on /xaa/token', async () => {
    const fixture = await createFixture();
    const proof = await createDpopProof({
      method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: fixture.dpopKeyPair,
      accessToken: 'not-applicable-here', now: fixture.now,
    });
    expect((await exchange(fixture, { proof })).status).toBe(400);
  });

  it('rejects two proofs on one request', async () => {
    const fixture = await createFixture();
    const one = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: fixture.dpopKeyPair, now: fixture.now });
    const two = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: fixture.dpopKeyPair, now: fixture.now });
    expect((await exchange(fixture, { proof: `${one}, ${two}` })).status).toBe(400);
  });

  it('sets cnf.jkt to the RFC 7638 thumbprint of the proof jwk', async () => {
    const fixture = await createFixture();
    const other = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: other, now: fixture.now });
    const response = await exchange(fixture, { proof });
    const body = await response.json() as { access_token: string };
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1]!, 'base64url').toString('utf8')) as { cnf: { jkt: string } };
    expect(claims.cnf.jkt).toBe(await jwkThumbprint(other.publicJwk));
  });

  it('answers every DPoP failure with one indistinguishable body', async () => {
    const fixture = await createFixture();
    const bodies = new Set<string>();
    const stale = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: fixture.dpopKeyPair, now: () => fixture.now() - 600_000 });
    for (const options of [
      { omitProof: true },
      { proof: stale },
      { proof: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/other`, keyPair: fixture.dpopKeyPair, now: fixture.now }) },
    ]) {
      bodies.add(await (await exchange(fixture, options)).text());
    }
    expect([...bodies]).toEqual(['{"error":"invalid_dpop_proof"}']);
  });
});
