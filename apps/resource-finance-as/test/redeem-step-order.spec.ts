import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair } from '@xaa/crypto';
import { createRedeemableAs } from './helpers.js';

/**
 * T-RES-06 fixes the redemption as an explicit sequence rather than the library's
 * one-shot helper, because the confirmation binding, the isolation gate and the
 * revocation check all have to sit between library steps. The order is the property:
 * a check that runs after the token is minted is not a check. REQ-08-044 also depends
 * on it — there is no branch that can skip ahead, so no Cloud Run header can shorten
 * the list.
 */
describe('the redemption pipeline runs in one fixed order', () => {
  it('walks every step in order on a successful redemption', async () => {
    const chain = await createRedeemableAs();
    expect((await chain.redeem()).status).toBe(200);
    expect(chain.as.steps).toEqual([
      'authorize_client', 'parse_params', 'verify_assertion', 'bind_cnf',
      'resolve_scope', 'registered_scope', 'isolation', 'revocation', 'issue_token', 'log',
    ]);
  });

  it('places the isolation gate before the revocation check and the issuer', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem({ assertion: await chain.mint({ isolationLevel: 'standard' }) });
    expect(response.status).toBe(403);
    expect(chain.as.steps).toEqual([
      'authorize_client', 'parse_params', 'verify_assertion', 'bind_cnf',
      'resolve_scope', 'registered_scope', 'isolation', 'log',
    ]);
  });

  it('stops at the failing step and never reaches the issuer', async () => {
    const chain = await createRedeemableAs();
    const response = await chain.redeem({ proofKeyPair: await generateEs256KeyPair() });
    expect(response.status).toBe(400);
    expect(chain.as.steps).toEqual(['authorize_client', 'parse_params', 'verify_assertion', 'bind_cnf', 'log']);
  });

  it('checks revocation before it mints anything', async () => {
    const revoked: string[] = [];
    const chain = await createRedeemableAs({}, {
      isActorRevoked: async (actorUrn) => { revoked.push(actorUrn); return true; },
    });
    const response = await chain.redeem();
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
    expect(revoked).toEqual(['urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz']);
    expect(chain.as.steps).not.toContain('issue_token');
  });
});
