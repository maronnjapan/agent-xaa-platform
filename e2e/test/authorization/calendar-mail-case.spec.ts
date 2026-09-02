import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeVertex, loadAiFixture } from '@xaa/authorization/src/testing/fixtures';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { controlPlaneGrant, startAuthorization, submitWorkRequest } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const HUMAN_PERMISSIONS = ['calendar.event.read', 'calendar.event.write', 'mail.message.read', 'mail.message.send'];

/**
 * docs 03 §2, end to end: "read today's calendar and mail the important entries".
 *
 * The point of the case is the middle, not the answer. Each stage removes something
 * for its own reason, and this test pins all five so a change to any one of them —
 * the model's proposal, the person's permissions, delegation, the organization's
 * policies, the risk rules — shows up as a failure here rather than as a quietly
 * different grant.
 *
 * The intermediate values are read from `ai_proposals` and `policy_decisions`, not
 * from the response: the response only says what survived.
 */
describe('the Calendar and Mail case', () => {
  it('narrows the proposal stage by stage down to what the agent may do', async () => {
    const fixture = loadAiFixture('calendar-mail');
    const vertex = createFakeVertex(fixture);
    const authz = await startAuthorization({ idpPublicJwk: idpJwk, humanPermissions: HUMAN_PERMISSIONS, vertex });

    const response = await submitWorkRequest({
      authz,
      grant: await controlPlaneGrant(),
      body: {
        purpose: '予定整理',
        description: '当日の予定を取得し、重要な予定を抽出して関係者へメールで共有する',
        requested_lifetime_hours: 8,
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      decision_id: string; effective_capabilities: string[];
      security_profile: { isolation_level: string; risk_score: number; reasons: string[] };
      denied: Array<{ capability_id: string; reason_code: string; policy_id: string | null }>;
    };

    // (1) Proposed: what the model asked for, after the taxonomy filter.
    const [proposal] = await authz.documents.listAll<{ proposed_capabilities: string[]; characteristics: Record<string, unknown> }>('ai_proposals');
    expect(proposal!.data.proposed_capabilities).toEqual(fixture.capabilities);

    // (2) Human: the four permissions this person holds.
    const permissions = await authz.seedStore.listAll<{ capability_id: string }>('human_permissions');
    expect(permissions.map(({ data }) => data.capability_id).sort()).toEqual([...HUMAN_PERMISSIONS].sort());

    // (3) Delegatable: calendar.event.write is refused even though the person holds it.
    const rows = await authz.documents.queryEqual<{ capability_id: string; decision: string; reason_code: string }>(
      'policy_decisions', [['decision_id', body.decision_id]],
    );
    const byCapability = new Map(rows.map(({ data }) => [data.capability_id, data]));
    expect(byCapability.get('calendar.event.write')).toMatchObject({ decision: 'DENY', reason_code: 'not_delegatable' });

    // (4) Organization policy: mail.message.send is removed by org-002, because no
    // connector in this deployment can send mail — a capability nothing implements is
    // an authority the agent could never exercise.
    expect(byCapability.get('mail.message.send')).toMatchObject({ decision: 'DENY', reason_code: 'org_policy_denied' });
    expect(body.denied.find((entry) => entry.capability_id === 'mail.message.send')?.policy_id).toBe('org-002');

    // (5) Risk policy: reading a calendar is standard work, so nothing is raised.
    expect(body.effective_capabilities).toEqual(['calendar.event.read']);
    expect(body.security_profile.isolation_level).toBe('standard');
    expect(body.security_profile.reasons).not.toContain('financial_operation');

    // One call to structure the work, one to propose capabilities. No more.
    expect(vertex.calls).toBe(2);
  });
});
