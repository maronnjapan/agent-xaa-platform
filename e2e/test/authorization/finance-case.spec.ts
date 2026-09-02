import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeVertex, loadAiFixture } from '@xaa/authorization/src/testing/fixtures';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { controlPlaneGrant, startAuthorization, submitWorkRequest, type AuthorizationHarness } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const HUMAN_PERMISSIONS = ['finance.payment.read', 'finance.payment.approve', 'document.read', 'document.write'];

const REQUEST = {
  purpose: '支払処理',
  description: '承認済みの支払情報を確認し、条件を満たす支払を承認する',
  requested_lifetime_hours: 4,
};

interface DecisionBody {
  decision_id: string;
  effective_capabilities: string[];
  security_profile: { isolation_level: string; risk_score: number; reasons: string[] };
}

async function decide(options: { riskWeight?: number } = {}): Promise<{ authz: AuthorizationHarness; body: DecisionBody }> {
  const authz = await startAuthorization({
    idpPublicJwk: idpJwk, humanPermissions: HUMAN_PERMISSIONS,
    vertex: createFakeVertex(loadAiFixture('finance')),
  });
  if (options.riskWeight !== undefined) {
    // The policy table is the seed Job's to write, and this is the same row with the
    // one number changed.
    const current = await authz.seedStore.get<Record<string, unknown>>('risk_policies', 'risk-001');
    await authz.seedStore.set('risk_policies', 'risk-001', { ...current!, weight: options.riskWeight });
  }
  const response = await submitWorkRequest({ authz, grant: await controlPlaneGrant(), body: REQUEST });
  expect(response.status).toBe(200);
  return { authz, body: await response.json() as DecisionBody };
}

/**
 * docs 02 §4 and specs 5.2: approving a payment runs in full isolation, and no score
 * can talk the platform out of it.
 *
 * `financial_operation` comes from the taxonomy rather than from the model, so the
 * containment does not depend on what the model chose to say about the work.
 */
describe('the Finance case', () => {
  it('grants both payment capabilities under full isolation', async () => {
    const { body } = await decide();

    expect(body.effective_capabilities).toEqual(['finance.payment.approve', 'finance.payment.read']);
    expect(body.security_profile.isolation_level).toBe('full_isolation');
    expect(body.security_profile.reasons).toContain('financial_operation');
  });

  it('stays in full isolation even when the rule barely scores', async () => {
    const { body } = await decide({ riskWeight: 1 });

    expect(body.security_profile.risk_score).toBeLessThan(80);
    // The level is the strongest min_isolation_level among the rules that matched,
    // not a function of the score: there is no rule that lowers one.
    expect(body.security_profile.isolation_level).toBe('full_isolation');
  });

  /**
   * The amount ceiling travels with the capability. The Resource Server checks the
   * same limit from the token (specs 5.2's double check); this is the half the
   * Authorization Platform is responsible for putting there.
   */
  it('attaches the risk policy ceiling to the approval capability', async () => {
    const { authz, body } = await decide();

    const decision = await authz.documents.get<{ constraints: Record<string, Record<string, unknown>> }>(
      'authorization_decisions', body.decision_id,
    );
    expect(decision!.constraints['finance.payment.approve']).toMatchObject({ max_amount: 100_000 });
  });
});
