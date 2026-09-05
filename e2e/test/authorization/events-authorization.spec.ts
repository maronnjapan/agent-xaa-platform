import { beforeAll, describe, expect, it } from 'vitest';
import { activityEventSchema, compile } from '@xaa/contracts';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { controlPlaneGrant, startAuthorization, submitWorkRequest, type AuthorizationHarness } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const assertActivityEvent: (value: unknown) => asserts value is unknown = compile(activityEventSchema);

async function decide(options: { humanPermissions?: string[]; failActivityPublish?: boolean } = {}): Promise<{
  authz: AuthorizationHarness; response: Response; body: { decision_id: string };
}> {
  const authz = await startAuthorization({
    idpPublicJwk: idpJwk,
    humanPermissions: options.humanPermissions ?? ['document.read', 'document.write'],
    ...(options.failActivityPublish ? { failActivityPublish: true } : {}),
    model: {
      operations: ['read_documents', 'write_document'],
      targetResources: ['document'],
      capabilities: ['document.read', 'document.write'],
    },
  });
  const response = await submitWorkRequest({
    authz,
    grant: await controlPlaneGrant(),
    body: { purpose: '書類整理', description: '書類を読んで整理する', requested_lifetime_minutes: 480 },
  });
  return { authz, response, body: await response.clone().json() as { decision_id: string } };
}

/**
 * REQ-11-009. One decision produces two events, in the order the person reads them:
 * what the agent may do, then how isolated it will be. Both go through the shared
 * Activity Event schema — a subscriber that receives one it cannot validate drops it,
 * and the timeline silently loses the authorization step.
 */
describe('the authorization step on the timeline', () => {
  it('emits CAPABILITY_DECIDED then ISOLATION_DECIDED, both schema-valid', async () => {
    const { authz, body, response } = await decide();
    expect(response.status).toBe(200);

    const types = authz.activity.map((event) => (event.detail as { event_type?: string } | undefined)?.event_type);
    expect(types).toEqual(['CAPABILITY_DECIDED', 'ISOLATION_DECIDED']);
    for (const event of authz.activity) {
      expect(() => assertActivityEvent(event)).not.toThrow();
      expect(event.phase).toBe('authorization');
      expect(event.human_subject).toBe('testuser');
      expect(event.trace_id).toContain(body.decision_id);
    }
  });

  it('says what was denied, not only what was allowed', async () => {
    const { authz } = await decide();
    const capability = authz.activity[0]!;
    const detail = capability.detail as { allowed: string[]; denied: unknown[] };
    expect(detail.allowed).toEqual(['document.read', 'document.write']);
    expect(Array.isArray(detail.denied)).toBe(true);
  });

  /**
   * REQ-11-031. The timeline is the person's account of what happened, so a refusal
   * has to be readable there: which capability was refused, and under which rule. A
   * `detail` nobody can read aloud is a decision the person cannot question.
   */
  it('names the refused capability and its reason in the message', async () => {
    const { authz } = await decide({ humanPermissions: ['document.read'] });

    const capability = authz.activity[0]!;
    const detail = capability.detail as { allowed: string[]; denied: Array<{ capability_id: string; violation_code: string }> };
    expect(detail.denied).toHaveLength(1);
    expect(detail.denied[0]).toEqual({ capability_id: 'document.write', violation_code: 'human_permission_exceeded' });
    expect(String(capability.message)).toContain('document.write');
    expect(String(capability.message)).toContain('human_permission_exceeded');
  });

  /**
   * The timeline is a display channel, not the decision (RULE-55). An unreachable
   * topic must not turn a decision that was taken and stored into an error the caller
   * would retry — it leaves a warning instead.
   */
  it('still answers 200 when the topic is unreachable, and warns once per event', async () => {
    const { authz, response, body } = await decide({ failActivityPublish: true });

    expect(response.status).toBe(200);
    expect(await authz.documents.get('authorization_decisions', body.decision_id)).toBeDefined();
    const warnings = authz.logs
      .map((line) => JSON.parse(line) as { event: string; severity: string })
      .filter((line) => line.event === 'activity_publish_failed');
    // One per event that could not be published: CAPABILITY_DECIDED and ISOLATION_DECIDED.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.severity).toBe('WARNING');
    expect(authz.activity).toEqual([]);
  });
});
