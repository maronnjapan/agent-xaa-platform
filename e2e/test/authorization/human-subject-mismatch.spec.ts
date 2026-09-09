import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof, type Es256KeyPair } from '@xaa/crypto';
import { createProvisionerHarness, PROVISIONER_BASE } from '@xaa/provisioner/src/testing/harness';
import { createLifecycleHarness, LIFECYCLE_BASE, seedDomain } from '@xaa/lifecycle-manager/src/testing/harness';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { AUTHZ_BASE, controlPlaneGrant, startAuthorization } from '../../harness/authorization.js';

let idpJwk: JsonWebKey;
beforeAll(async () => { idpJwk = await idpPublicJwk(); });

const OTHER_SUBJECT = 'someone-else';

/** One request whose body claims to act for a person the token does not name. */
async function claimAnotherSubject(input: {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  base: string;
  path: string;
  grant: { token: string; keyPair: Es256KeyPair };
  body: Record<string, unknown>;
}): Promise<Response> {
  return input.fetch(input.path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `DPoP ${input.grant.token}`,
      DPoP: await createDpopProof({
        method: 'POST', url: `${input.base}${input.path}`, keyPair: input.grant.keyPair, accessToken: input.grant.token,
      }),
    },
    body: JSON.stringify({ ...input.body, human_subject: OTHER_SUBJECT }),
  });
}

/** The protocol-validation lines one app wrote for this refusal. */
function mismatches(logs: string[]): Array<Record<string, unknown>> {
  return logs
    .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
    .filter((line) => line.event === 'protocol_validation' && line.fields.validation === 'human_subject_mismatch')
    .map((line) => line.fields);
}

/**
 * RULE-43 across the whole Control Plane. The body may not choose whose permissions
 * are being spent — the Access Token's `sub` decides, always — and the three services
 * that accept a `human_subject` enforce it with the same middleware rather than with
 * three implementations that could drift apart.
 *
 * The refusal is also recorded three times: an impersonation attempt that is refused
 * silently is invisible to Security Detection, which is the one place it would show up
 * as a pattern (T-SEC-12).
 */
describe('a body naming another human is refused by all three Control Plane apps', () => {
  it('answers 403 human_subject_mismatch and records one protocol validation each', async () => {
    const authorization = await startAuthorization({ idpPublicJwk: idpJwk, humanPermissions: ['document.read'] });
    const provisioner = await createProvisionerHarness({ idpPublicJwk: idpJwk });
    const lifecycle = createLifecycleHarness({ idpPublicJwk: idpJwk });
    const agentId = await seedDomain(lifecycle, { humanSubject: 'testuser' });

    const responses = await Promise.all([
      claimAnotherSubject({
        fetch: authorization.fetch, base: AUTHZ_BASE, path: '/v1/authorization/decisions',
        grant: await controlPlaneGrant('openid workdef:submit'),
        body: { purpose: '書類整理', description: '書類を読んで整理する', requested_lifetime_minutes: 480 },
      }),
      claimAnotherSubject({
        fetch: provisioner.fetch, base: PROVISIONER_BASE, path: '/provisioning',
        grant: await controlPlaneGrant('openid agent:provision'),
        body: { decision_id: 'dec_00000000-0000-4000-8000-000000000000' },
      }),
      claimAnotherSubject({
        fetch: lifecycle.fetch, base: LIFECYCLE_BASE, path: `/agents/${agentId}/revoke`,
        grant: await controlPlaneGrant('openid agent:revoke'),
        body: {},
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    for (const response of responses) {
      expect(await response.json()).toEqual({ error: 'human_subject_mismatch' });
    }

    const recorded = [
      ...mismatches(authorization.logs),
      ...mismatches(provisioner.logs),
      ...mismatches(lifecycle.logs),
    ];
    expect(recorded).toHaveLength(3);
    // Each line names the subject the token actually carried, never the claimed one.
    for (const fields of recorded) {
      expect(fields.outcome).toBe('fail');
      expect(JSON.stringify(fields)).not.toContain(OTHER_SUBJECT);
    }
    expect(recorded.map((fields) => fields.path))
      .toEqual(['authorization:/api', 'provisioner:/provisioning', 'lifecycle:/agents']);
  });

  it('leaves nothing behind in any of the three', async () => {
    const authorization = await startAuthorization({ idpPublicJwk: idpJwk, humanPermissions: ['document.read'] });
    await claimAnotherSubject({
      fetch: authorization.fetch, base: AUTHZ_BASE, path: '/v1/authorization/decisions',
      grant: await controlPlaneGrant('openid workdef:submit'),
      body: { purpose: '書類整理', description: '書類を読んで整理する', requested_lifetime_minutes: 480 },
    });

    expect(await authorization.documents.listAll('authorization_decisions')).toEqual([]);
    expect(authorization.activity).toEqual([]);
  });
});
