import { beforeAll, describe, expect, it } from 'vitest';
import { createFakeVertex, loadAiFixture } from '@xaa/authorization/src/testing/fixtures';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { controlPlaneGrant, startAuthorization, submitWorkRequest, type AuthorizationHarness } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const HUMAN_PERMISSIONS = ['mail.message.send', 'calendar.event.read', 'document.write'];

interface DecisionBody {
  decision_id: string;
  effective_capabilities: string[];
  denied: Array<{ capability_id: string; reason_code: string; policy_id: string | null }>;
}

async function run(): Promise<{ authz: AuthorizationHarness; body: DecisionBody }> {
  const authz = await startAuthorization({
    idpPublicJwk: idpJwk, humanPermissions: HUMAN_PERMISSIONS,
    vertex: createFakeVertex(loadAiFixture('external-mail')),
  });
  const response = await submitWorkRequest({
    authz,
    grant: await controlPlaneGrant(),
    body: {
      purpose: '会議要約の共有',
      description: '社外の取引先へ会議の要約をメールで送る',
      requested_lifetime_minutes: 240,
    },
  });
  expect(response.status).toBe(200);
  return { authz, body: await response.json() as DecisionBody };
}

/**
 * Demo D-2 (REQ-11-031), driven through the API alone: a request that asks for
 * something the organization does not allow, and the refusal as it reaches the
 * person's timeline.
 *
 * Nothing here calls the Policy Engine directly. What a demo has to show is that the
 * refusal happens on the ordinary path — a test that computed the decision itself
 * would prove only that the function works, not that the platform uses it.
 */
describe('an organization policy refusal, seen from the timeline', () => {
  it('names organization_policy_violation in the capability event', async () => {
    const { authz } = await run();

    const capabilityEvent = authz.activity[0]!;
    expect((capabilityEvent.detail as { event_type: string }).event_type).toBe('CAPABILITY_DECIDED');
    const denied = (capabilityEvent.detail as { denied: Array<{ capability_id: string; violation_code: string }> }).denied;
    expect(denied.filter((entry) => entry.violation_code === 'organization_policy_violation')).toHaveLength(1);
    expect(denied.find((entry) => entry.violation_code === 'organization_policy_violation')?.capability_id)
      .toBe('mail.message.send');
    expect(String(capabilityEvent.message)).toContain('organization_policy_violation');
  });

  it('records the same refusal as org_policy_denied in policy_decisions', async () => {
    const { authz, body } = await run();

    const rows = await authz.documents.queryEqual<{ capability_id: string; reason_code: string; policy_id: string }>(
      'policy_decisions', [['decision_id', body.decision_id]],
    );
    const orgDenied = rows.filter(({ data }) => data.reason_code === 'org_policy_denied');
    // The stored reason and the published violation are the two ends of one mapping
    // (T-AUTHZ-22's REASON_TO_VIOLATION), and this is where they are compared.
    expect(orgDenied).toHaveLength(1);
    expect(orgDenied[0]!.data).toMatchObject({ capability_id: 'mail.message.send', policy_id: 'org-002' });
  });

  it('leaves the work the organization does allow', async () => {
    const { body } = await run();

    // calendar.event.read has a connector and survives; the constraint carried by
    // org-001 belongs to mail.message.send, which org-002 removed first.
    expect(body.effective_capabilities).toEqual(['calendar.event.read', 'document.write']);
    expect(body.denied.map((entry) => entry.capability_id)).toEqual(['mail.message.send']);
  });
});
