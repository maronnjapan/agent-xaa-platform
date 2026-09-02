import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair } from '@xaa/crypto';
import { AS_ISSUER, createRedeemableAs } from './helpers.js';

/**
 * DEC-ID-14 / REQ-05-085. Client authentication on this token endpoint is possession
 * of the key the ID-JAG was bound to. A presented DPoP header proves nothing by
 * itself, so each case below changes exactly one thing about the proof.
 */
describe('client binding by cnf.jkt', () => {
  it('rejects cnf-bearing JAG without proof', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem({ omitProof: true });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects cnf-bearing JAG with other key', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem({ proofKeyPair: await generateEs256KeyPair() });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('accepts matching proof', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem();
    expect(response.status).toBe(200);
    const body = await response.json() as { access_token: string; token_type: string };
    expect(body.token_type).toBe('DPoP');
    expect(body.access_token.length).toBeGreaterThan(0);
  });

  it('rejects an assertion that carries no cnf at all', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem({ assertion: await chain.mint({ jkt: null }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('reports a replayed proof jti as replayed_dpop_proof', async () => {
    const chain = await createRedeemableAs();
    const proof = await createDpopProof({ method: 'POST', url: `${AS_ISSUER}/token`, keyPair: chain.dpopKeyPair });
    expect((await chain.redeem({ proof })).status).toBe(200);

    const replay = await chain.redeem({ proof });
    expect(replay.status).toBe(400);
    expect((await replay.json() as { error: string }).error).toBe('invalid_grant');

    const entry = chain.as.logs.map((line) => JSON.parse(line) as { event: string; fields: { validation_name: string } })
      .filter((line) => line.event === 'resource_as.redeem').at(-1);
    expect(entry!.fields.validation_name).toBe('replayed_dpop_proof');
  });
});
