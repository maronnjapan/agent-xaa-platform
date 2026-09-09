import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import { createProvisionerHarness, seedDecision, PROVISIONER_BASE, type ProvisionerHarness } from '@xaa/provisioner/src/testing/harness';
import { authorize, tokenRequest } from '../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../harness/human-idp.js';

/**
 * REQ-09-007. The one line an auditor reads to say what an agent was allowed to do and
 * what was built for it.
 *
 * It is asserted end to end rather than on the builder, because the fields that matter
 * most are the ones a unit test has to be handed: `dedicated_short_id` is null for a
 * STANDARD agent and the short id of a real dedicated OP for a FULL_ISOLATION one, and
 * that difference only exists once a provisioning has actually taken a branch.
 *
 * The token is minted by the real Human IdP here, so the `human_subject` on the line is
 * the `sub` of a token someone logged in to obtain, rather than a string the test chose.
 */
interface Caller { token: string; keyPair: Es256KeyPair }

async function callerToken(): Promise<Caller> {
  const idp = await startHumanIdp();
  const keyPair = await generateEs256KeyPair();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
    scope: 'openid agent:provision', issuer: HUMAN_IDP_ISSUER, audience: 'agent-provisioner',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
    dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
      code_verifier: result.pkce.verifier, client_id: 'automation-app',
    },
  });
  const body = await response.json() as { access_token: string };
  return { token: body.access_token, keyPair };
}

async function provision(
  provisioner: ProvisionerHarness, caller: Caller, decisionId: string,
): Promise<Response> {
  return provisioner.fetch('/provisioning', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `DPoP ${caller.token}`,
      DPoP: await createDpopProof({
        method: 'POST', url: `${PROVISIONER_BASE}/provisioning`, keyPair: caller.keyPair, accessToken: caller.token,
      }),
    },
    body: JSON.stringify({ decision_id: decisionId, task_id: 'task-1', requested_lifetime_minutes: 60 }),
  });
}

function completionLine(provisioner: ProvisionerHarness): Record<string, unknown> {
  const line = provisioner.logs
    .map((entry) => JSON.parse(entry) as { fields: Record<string, unknown> })
    .find((entry) => entry.fields.event === 'provisioning_completed');
  expect(line).toBeDefined();
  return line!.fields;
}

const REQUIRED_FIELDS = [
  'agent_id', 'human_subject', 'transaction_id', 'isolation_level', 'dedicated_op', 'dedicated_short_id',
  'provisioned_tools', 'allowed_audiences', 'resources', 'scopes', 'idp_connection_status',
  'connector_states', 'created_at', 'expires_at',
];

describe('the provisioning completion log', () => {
  it('names the dedicated OP for a FULL_ISOLATION agent and null for a STANDARD one', async () => {
    const idpJwk = await idpPublicJwk();
    const caller = await callerToken();

    const standard = await createProvisionerHarness({ idpPublicJwk: idpJwk });
    const standardDecision = await seedDecision(standard, { capabilities: ['document.read'] });
    expect((await provision(standard, caller, standardDecision)).status).toBe(201);

    const isolated = await createProvisionerHarness({ idpPublicJwk: idpJwk });
    const isolatedDecision = await seedDecision(isolated, {
      capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation',
    });
    expect((await provision(isolated, caller, isolatedDecision)).status).toBe(201);

    const standardLine = completionLine(standard);
    const isolatedLine = completionLine(isolated);

    expect(standardLine.isolation_level).toBe('standard');
    expect(standardLine.dedicated_op).toBe(false);
    expect(standardLine.dedicated_short_id).toBe(null);

    expect(isolatedLine.isolation_level).toBe('full_isolation');
    expect(isolatedLine.dedicated_op).toBe(true);
    // The short id is what joins this line to the six resources in the ledger and to
    // the Cloud Run service names an operator will see in the console.
    expect(isolatedLine.dedicated_short_id).not.toBe(null);
    expect(isolatedLine.dedicated_short_id).toBe(String(isolatedLine.agent_id).slice(-12));

    for (const line of [standardLine, isolatedLine]) {
      for (const field of REQUIRED_FIELDS) expect(line).toHaveProperty(field);
      expect(line.human_subject).toBe('testuser');
    }
  });

  it('carries no token-shaped value on either line', async () => {
    const idpJwk = await idpPublicJwk();
    const caller = await callerToken();
    const provisioner = await createProvisionerHarness({ idpPublicJwk: idpJwk });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    expect((await provision(provisioner, caller, decisionId)).status).toBe(201);

    // RULE-38. The line is written to a sink an operator can read; a JWT that reached
    // it would be a usable credential sitting in the audit trail.
    const jwtShape = /"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"/;
    expect(JSON.stringify(completionLine(provisioner))).not.toMatch(jwtShape);
    expect(provisioner.logs.join('\n')).not.toContain(caller.token);
  });
});
