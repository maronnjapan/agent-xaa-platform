import { describe, expect, it } from 'vitest';
import { createDpopProof, decodeJwsUnverified, generateEs256KeyPair, InMemoryJtiStore, jwkThumbprint } from '@xaa/crypto';
import { bindDpop, DpopBindingError } from '../src/auth/dpop-token-binding.js';
import { blanketDpopApplies } from '../src/config/dpop-required-audiences.js';
import { AGENT_PLATFORM_CLIENT_ID, AUTOMATION_APP_CLIENT_ID } from '../src/config/clients.js';

const ISSUER = 'https://human-idp.test';

async function proofFor(keyPair: Awaited<ReturnType<typeof generateEs256KeyPair>>) {
  return createDpopProof({ method: 'POST', url: `${ISSUER}/token`, keyPair });
}

describe('DPoP token binding at /token', () => {
  it('binds cnf.jkt to the proof key', async () => {
    const keyPair = await generateEs256KeyPair();
    const result = await bindDpop({
      proofs: [await proofFor(keyPair)], issuer: ISSUER, jtiStore: new InMemoryJtiStore(),
      audience: ['agent-provisioner'], alwaysRequired: false,
    });
    expect(result.status).toBe('valid');
    expect(result.jkt).toBe(await jwkThumbprint(keyPair.publicJwk));
  });

  it('requires a proof for a Control Plane audience even when DPOP_REQUIRED is false', async () => {
    await expect(bindDpop({
      proofs: [], issuer: ISSUER, jtiStore: new InMemoryJtiStore(),
      audience: ['lifecycle-manager'], alwaysRequired: false,
    })).rejects.toBeInstanceOf(DpopBindingError);
  });

  it('rejects a missing proof when DPOP_REQUIRED is true', async () => {
    await expect(bindDpop({
      proofs: [], issuer: ISSUER, jtiStore: new InMemoryJtiStore(), audience: ['automation-app'], alwaysRequired: true,
    })).rejects.toBeInstanceOf(DpopBindingError);
  });

  it('reports absent, not an error, when no proof is needed', async () => {
    const result = await bindDpop({
      proofs: [], issuer: ISSUER, jtiStore: new InMemoryJtiStore(), audience: ['automation-app'], alwaysRequired: false,
    });
    expect(result).toEqual({ status: 'absent' });
  });

  it('rejects a replayed jti', async () => {
    const keyPair = await generateEs256KeyPair();
    const jtiStore = new InMemoryJtiStore();
    const proof = await proofFor(keyPair);
    await bindDpop({ proofs: [proof], issuer: ISSUER, jtiStore, audience: ['agent-provisioner'], alwaysRequired: true });
    await expect(bindDpop({ proofs: [proof], issuer: ISSUER, jtiStore, audience: ['agent-provisioner'], alwaysRequired: true }))
      .rejects.toBeInstanceOf(DpopBindingError);
  });

  it('rejects two proofs on one request', async () => {
    const keyPair = await generateEs256KeyPair();
    await expect(bindDpop({
      proofs: [await proofFor(keyPair), await proofFor(keyPair)], issuer: ISSUER,
      jtiStore: new InMemoryJtiStore(), audience: ['agent-provisioner'], alwaysRequired: true,
    })).rejects.toBeInstanceOf(DpopBindingError);
  });

  /**
   * RULE-06 covers three routes and all three end at a Control Plane audience. The
   * blanket flag must not reach past them: `agent-platform` redeems its authorization
   * code and refreshes it from the Agent OP, server to server, with no DPoP key, and
   * requiring a proof there broke the offline_access consent outright.
   */
  it('binds the blanket flag to Control Plane clients only', () => {
    expect(blanketDpopApplies(AUTOMATION_APP_CLIENT_ID)).toBe(true);
    expect(blanketDpopApplies(AGENT_PLATFORM_CLIENT_ID)).toBe(false);
    expect(blanketDpopApplies('unregistered')).toBe(false);
  });

  it('rejects a proof made for a different endpoint', async () => {
    const keyPair = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'POST', url: `${ISSUER}/introspect`, keyPair });
    expect(decodeJwsUnverified(proof).payload.htu).toBe(`${ISSUER}/introspect`);
    await expect(bindDpop({
      proofs: [proof], issuer: ISSUER, jtiStore: new InMemoryJtiStore(), audience: ['agent-provisioner'], alwaysRequired: true,
    })).rejects.toBeInstanceOf(DpopBindingError);
  });
});
