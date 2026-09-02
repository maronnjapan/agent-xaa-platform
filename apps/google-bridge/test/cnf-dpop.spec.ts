import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair } from '@xaa/crypto';
import { INTERNAL_BASE, exchangeToken, readyBridge } from '../src/testing/harness.js';

/**
 * Proof of possession on the ID-JAG, added above the library (DEV-11, RULE-44).
 *
 * maronn's redeem helpers do not look at `cnf`, so on their own the Bridge would hand a
 * SaaS token to anyone holding a copy of the assertion. Everything here is about the
 * one question those helpers cannot answer: is the caller the party the Agent OP bound
 * the token to?
 *
 * A missing proof and a broken one are told apart on purpose. "You sent no proof" is
 * about the grant being incomplete; "your proof did not check out" is about the proof.
 * REQ-06-004 asks for both, and collapsing them would hide a client that is sending a
 * proof the Bridge silently ignores.
 */
describe('cnf and the DPoP proof', () => {
  it('no proof -> invalid_grant', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), omitProof: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('other key -> invalid_dpop_proof', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const stolen = await generateEs256KeyPair();
    // The assertion names one key; the proof is signed with another. This is what a
    // replayed ID-JAG looks like from the Bridge's side.
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey: stolen });
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('htu mismatch -> invalid_dpop_proof', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, {
      idJag: await issuer.mint({ dpopKey }),
      // A proof made for a different endpoint is a proof someone else's service was
      // given, and it must not be usable here.
      proof: await createDpopProof({ method: 'POST', url: 'https://elsewhere.test/token', keyPair: dpopKey }),
    });
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('replayed jti -> invalid_dpop_proof', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const proof = await createDpopProof({ method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: dpopKey });
    expect((await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), proof })).status).toBe(200);
    const second = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), proof });
    expect(await second.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('valid proof -> 200', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    expect(response.status).toBe(200);
  });

  it('refuses a proof that carries ath', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, {
      idJag: await issuer.mint({ dpopKey }),
      // `/token` issues no Access Token of its own, so there is nothing for `ath` to
      // bind to: a proof carrying one was made for a different request.
      proof: await createDpopProof({
        method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: dpopKey, accessToken: 'some-token',
      }),
    });
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('refuses an ID-JAG with no cnf at all', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    // DEC-ID-08's counterpart: the OP has no branch that issues one without `cnf`, so
    // the Bridge has none that accepts one. Fail-closed at both ends.
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ omitCnf: true }), dpopKey });
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('refuses a proof issued 61 seconds ago', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, {
      idJag: await issuer.mint({ dpopKey }),
      proof: await createDpopProof({
        method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: dpopKey,
        now: () => Date.now() - 61_000,
      }),
    });
    // Just outside the window. A proof is meant to be made for the request it travels
    // with; a wide window is a wide replay opportunity.
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });
});
