import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createProvisionerHarness, seedDecision, PROVISIONER_BASE } from '@xaa/provisioner/src/testing/harness';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { startAgentOp } from '../../harness/agent-op.js';

/**
 * The consent round trip, across the three services that make it.
 *
 * The Provisioner pauses, the Agent OP finishes the consent and hands the browser back
 * to the Automation App, and the Automation App presents the code to the Provisioner.
 * Every hop here is a different app writing or reading the same one-time code, which is
 * exactly what a per-app test cannot check: the code used to be written to one
 * collection and looked for in another, and both sides' own tests passed.
 *
 * What the trip is for is the agent at the end of it. The one-time code arriving
 * intact is only half the journey — the resume used to accept it, mark the transaction
 * `RESUMABLE` and stop, spending the consent to reach a state nothing else advances,
 * so a person who consented was returned to a dashboard with no agent on it and no
 * error to explain why.
 */
async function provisionerToken(): Promise<{ token: string; keyPair: Es256KeyPair }> {
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
  await jwkThumbprint(keyPair.publicJwk);
  return { token: body.access_token, keyPair };
}

describe('coming back from the IdP consent', () => {
  it('carries the one-time code from the Agent OP to the Provisioner', async () => {
    const shared = createFirestoreDouble();
    const idpJwk = await idpPublicJwk();
    const provisioner = await createProvisionerHarness({
      shared, idpPublicJwk: idpJwk, idpConnectionStatus: 'CONSENT_REQUIRED', verifyStatus: 'READY',
    });
    const caller = await provisionerToken();

    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const paused = await provisioner.fetch('/provisioning', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${caller.token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}/provisioning`, keyPair: caller.keyPair, accessToken: caller.token,
        }),
      },
      body: JSON.stringify({ decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 1 }),
    });
    const started = await paused.json() as { status: string; transaction_id: string };
    expect(started.status).toBe('IDP_CONSENT_REQUIRED');

    // The consent is given for the agent the paused transaction named, and the
    // connection the Agent OP writes belongs to that agent — not to whatever id this
    // harness happens to have been started with.
    const parked = (await provisioner.documents.get<{ agent_id: string; agent_expires_at: string }>(
      'provisioning_transactions', started.transaction_id,
    ))!;

    // The Agent OP finishes the consent over the same Firestore.
    const agentOp = await startAgentOp({
      shared, idpPublicJwk: idpJwk,
      config: { mode: 'callback' },
      humanIdpFetch: (async () => Response.json({ refresh_token: 'rt-1' })) as unknown as typeof fetch,
    });
    const opStore = createFirestoreDocumentStore(shared, 'agent-op');
    await opStore.set('bridge_consent_states', 'state-1', {
      transaction_id: started.transaction_id,
      agent_id: parked.agent_id,
      human_subject: 'testuser',
      code_verifier: 'verifier-1',
      idp_connection_id: `idpconn-${parked.agent_id}`,
      // The agent's own expiry, which is what the Agent OP stores on the connection.
      expires_at: parked.agent_expires_at,
      used: false,
    });

    const redirected = await agentOp.fetch('/xaa/callback?code=authz-code&state=state-1');
    expect(redirected.status).toBe(302);
    const location = new URL(redirected.headers.get('location')!);
    expect(location.pathname).toBe('/provisioning/resume');
    // Exactly these two parameters, compared as a set: an extra one would be something
    // the Agent OP put in a browser's address bar, which is where a token must never be.
    expect(new Set([...location.searchParams.keys()])).toEqual(new Set(['transaction_id', 'code']));
    const code = location.searchParams.get('code')!;

    // And the code the browser carries is one the Provisioner accepts. The Automation
    // App makes this call on the person's behalf; here it is made with the same token
    // and the same body, so the assertion is about the code rather than the session.
    const resumePath = `/provisioning/${started.transaction_id}/resume`;
    const resumed = await provisioner.fetch(resumePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${caller.token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}${resumePath}`, keyPair: caller.keyPair, accessToken: caller.token,
        }),
      },
      body: JSON.stringify({ one_time_code: code }),
    });

    expect(resumed.status).toBe(201);
    const provisioned = await resumed.json() as { status: string; agent_id: string; expires_at: string };
    expect(provisioned.status).toBe('PROVISIONED');
    // The agent the consent was given for, not a new one: the Agent OP wrote the
    // connection under this id, and a different agent would hold no delegation.
    expect(provisioned.agent_id).toBe(parked.agent_id);

    const registration = (await provisioner.documents.get<{ status: string; expires_at: string }>(
      'agents', `${provisioned.agent_id}__meta`,
    ))!;
    expect(registration.status).toBe('ACTIVE');
    expect(provisioner.jobRuns).toHaveLength(1);

    // RULE-26 across the pause. The expiry was fixed before the person was sent away,
    // and the registration written after they came back carries the same string the
    // connection does — recomputing it on the way back would have handed the agent
    // however long the consent screen took.
    const connection = (await opStore.get<{ expires_at: string }>(
      'idp_connections', `idpconn-${provisioned.agent_id}`,
    ))!;
    expect(registration.expires_at).toBe(connection.expires_at);
    expect(registration.expires_at).toBe(parked.agent_expires_at);
  });

  /**
   * One consent, one agent. The code is single-use and the transaction it names is
   * finished by the first presentation, so a replayed redirect — a refresh, a back
   * button, a copied URL — is refused rather than provisioning a second agent on the
   * strength of a consent that was given once.
   */
  it('refuses the same code a second time', async () => {
    const shared = createFirestoreDouble();
    const idpJwk = await idpPublicJwk();
    const provisioner = await createProvisionerHarness({
      shared, idpPublicJwk: idpJwk, idpConnectionStatus: 'CONSENT_REQUIRED', verifyStatus: 'READY',
    });
    const caller = await provisionerToken();
    const decisionId = await seedDecision(provisioner, { capabilities: ['document.read'] });
    const paused = await provisioner.fetch('/provisioning', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${caller.token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}/provisioning`, keyPair: caller.keyPair, accessToken: caller.token,
        }),
      },
      body: JSON.stringify({ decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 1 }),
    });
    const started = await paused.json() as { transaction_id: string };

    const agentOp = await startAgentOp({
      shared, idpPublicJwk: idpJwk,
      config: { mode: 'callback' },
      humanIdpFetch: (async () => Response.json({ refresh_token: 'rt-1' })) as unknown as typeof fetch,
    });
    const opStore = createFirestoreDocumentStore(shared, 'agent-op');
    await opStore.set('bridge_consent_states', 'state-1', {
      transaction_id: started.transaction_id,
      agent_id: agentOp.agentId,
      human_subject: 'testuser',
      code_verifier: 'verifier-1',
      idp_connection_id: `idpconn-${agentOp.agentId}`,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      used: false,
    });
    const location = new URL((await agentOp.fetch('/xaa/callback?code=authz-code&state=state-1')).headers.get('location')!);
    const code = location.searchParams.get('code')!;

    const resumePath = `/provisioning/${started.transaction_id}/resume`;
    const present = async () => provisioner.fetch(resumePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DPoP ${caller.token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}${resumePath}`, keyPair: caller.keyPair, accessToken: caller.token,
        }),
      },
      body: JSON.stringify({ one_time_code: code }),
    });

    expect((await present()).status).toBe(201);
    const second = await present();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'transaction_not_resumable' });
    // And the refusal is not merely a status: nothing ran twice.
    expect(provisioner.jobRuns).toHaveLength(1);
  });
});
