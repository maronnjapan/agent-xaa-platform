import { describe, expect, it } from 'vitest';
import { validateActivityEvent } from '@xaa/contracts';
import { createDpopProof, generateEs256KeyPair, type Es256KeyPair } from '@xaa/crypto';
import { createProvisionerHarness, seedDecision, PROVISIONER_BASE, type ProvisionerHarness } from '@xaa/provisioner/src/testing/harness';
import { authorize, tokenRequest } from '../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../harness/human-idp.js';

/**
 * REQ-07-038 / RULE-55 / RULE-59. What a person sees on the timeline while an agent is
 * being made.
 *
 * The events are a separate stream from the security logs and are meant to be replayed
 * in order, which is why each carries a `sequence` numbered per transaction rather than
 * a timestamp: two events written in the same millisecond still have an order, and a
 * replay that guessed would show the consent after the agent it gated.
 *
 * The terminal event is the one to be careful about. `AGENT_PROVISIONED` is published
 * from the single place the transaction becomes COMPLETED, so a provisioning that
 * paused or failed cannot produce one — a timeline saying an agent is ready when it is
 * not is worse than a timeline that stops.
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

async function provision(provisioner: ProvisionerHarness, caller: Caller, decisionId: string): Promise<Response> {
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

function kinds(provisioner: ProvisionerHarness): string[] {
  return provisioner.activity.map((event) => (event.detail as { activity_kind: string }).activity_kind);
}

describe('the Activity Events a provisioning publishes', () => {
  it('ends a successful run with exactly one AGENT_PROVISIONED, numbered in order', async () => {
    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk() });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    expect((await provision(provisioner, await callerToken(), decisionId)).status).toBe(201);

    expect(kinds(provisioner).filter((kind) => kind === 'AGENT_PROVISIONED')).toHaveLength(1);
    expect(kinds(provisioner).at(-1)).toBe('AGENT_PROVISIONED');

    const sequences = provisioner.activity.map((event) => (event.detail as { sequence: number }).sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    // Every one is a shape the timeline's subscriber accepts; one that is not would be
    // dropped there and be indistinguishable from an event never published.
    for (const event of provisioner.activity) {
      expect(() => validateActivityEvent(event)).not.toThrow();
      expect(event.phase).toBe('provisioning');
      expect(event.source).toBe('provisioner');
    }
  });

  it('says a consent is needed once, and claims no agent while it waits', async () => {
    const provisioner = await createProvisionerHarness({
      idpPublicJwk: await idpPublicJwk(), idpConnectionStatus: 'CONSENT_REQUIRED',
    });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const response = await provision(provisioner, await callerToken(), decisionId);
    expect(response.status).toBe(200);

    expect(kinds(provisioner).filter((kind) => kind === 'IDP_CONSENT_REQUIRED')).toHaveLength(1);
    expect(kinds(provisioner)).not.toContain('AGENT_PROVISIONED');
    expect(provisioner.jobRuns).toHaveLength(0);
  });

  it('publishes no AGENT_PROVISIONED for a run that failed', async () => {
    // The connection never becomes usable, so the run stops at the gate before the
    // registration. A timeline that announced an agent here would be announcing one
    // that can obtain nothing.
    const provisioner = await createProvisionerHarness({ idpPublicJwk: await idpPublicJwk(), verifyStatus: 'PENDING' });
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const response = await provision(provisioner, await callerToken(), decisionId);
    expect(response.status).toBe(409);

    expect(kinds(provisioner)).not.toContain('AGENT_PROVISIONED');
    const jwtShape = /"eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"/;
    expect(JSON.stringify(provisioner.activity)).not.toMatch(jwtShape);
  });
});
