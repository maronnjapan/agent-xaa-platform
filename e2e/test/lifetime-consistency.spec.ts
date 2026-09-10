import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { createCatalogRepository } from '@xaa/provisioner/src/catalog/repository';
import { provisionAgent } from '@xaa/provisioner/src/provisioning/flow';
import { createProvisionerHarness, seedDecision } from '@xaa/provisioner/src/testing/harness';
import { idpPublicJwk } from '../harness/human-idp.js';
import { startAgentOp } from '../harness/agent-op.js';

/**
 * RULE-26 / REQ-07-018. The agent's expiry is carried into the connection layer, and
 * the two are compared here across the services that actually hold them.
 *
 * The Cloud Run task timeout ends the process. It does not end the delegation: an IdP
 * connection that outlived the agent would still exchange a refresh token on its
 * behalf. So the Provisioner computes the expiry once and hands the same string to the
 * registration it writes and to the Agent OP it asks for a connection — and this test
 * reads both back out of Firestore rather than out of the value it passed in.
 *
 * The Bridge's Agent Binding is the third place in a deployment that has the Bridge
 * on. It is off by default (DEC-SCOPE-04), so `agent_bindings` is asserted empty here
 * rather than compared; the binding's own expiry is fixed by the Bridge's tests.
 */
const PROVISIONER_SA = 'sa-provisioner@xaa-test.iam.gserviceaccount.com';

describe('one expiry, across the Provisioner and the Agent OP', () => {
  it('writes the same second to the registration and to the IdP connection', async () => {
    const shared = createFirestoreDouble();
    const idpJwk = await idpPublicJwk();

    // Two faces of the Agent OP, as Terraform deploys them: the token service holds
    // the internal API, the callback service takes the browser back from the consent.
    const tokenOp = await startAgentOp({ shared, idpPublicJwk: idpJwk, provisionerServiceAccount: PROVISIONER_SA });
    const callbackOp = await startAgentOp({
      shared, idpPublicJwk: idpJwk, config: { mode: 'callback' },
      humanIdpFetch: (async () => Response.json({ refresh_token: 'rt-1' })) as unknown as typeof fetch,
    });

    const provisioner = await createProvisionerHarness({ shared, idpPublicJwk: idpJwk });
    await seedDecision(provisioner, { capabilities: ['document.read'] });

    const internal = async (path: string, body?: unknown): Promise<Response> => tokenOp.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer sa-id-token' },
      body: JSON.stringify(body ?? {}),
    });

    const outcome = await provisionAgent({
      ...provisioner.deps,
      logger: createLogger('provisioner', 'provisioner', (line) => { provisioner.logs.push(line); }),
      catalogue: createCatalogRepository(provisioner.documents),
      agentOp: {
        ...provisioner.deps.agentOp,
        async createIdpConnection(input) {
          const first = await internal('/internal/idp-connections', input);
          const created = await first.json() as { status: 'READY' | 'CONSENT_REQUIRED'; consentUrl: string };
          if (created.status === 'READY') return created;

          // The browser leg, driven here rather than clicked: the Agent OP redeems the
          // code and stores the connection with the expiry the Provisioner named.
          const state = new URL(created.consentUrl).searchParams.get('state')!;
          const redirected = await callbackOp.fetch(`/xaa/callback?code=authz-code&state=${state}`);
          expect(redirected.status).toBe(302);

          const second = await internal('/internal/idp-connections', input);
          return await second.json() as { status: 'READY' | 'CONSENT_REQUIRED'; consentUrl: string };
        },
        async verifyIdpConnection(idpConnectionId) {
          const response = await internal(`/internal/idp-connections/${encodeURIComponent(idpConnectionId)}/verify`);
          return await response.json() as { status: string };
        },
      },
    }, {
      humanSubject: 'testuser', taskId: 'task-1', effectiveCapabilities: ['document.read'],
      isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', minutes: 60 },
    });

    expect(outcome.status).toBe(201);
    const agentId = (outcome.body as { agent_id: string }).agent_id;

    const registration = (await provisioner.documents.get<{ expires_at: string }>('agents', `${agentId}__meta`))!;
    const agentOpView = createFirestoreDocumentStore(shared, 'agent-op');
    const connection = (await agentOpView.get<{ expires_at: string; agent_id: string }>(
      'idp_connections', `idpconn-${agentId}`,
    ))!;

    expect(connection.agent_id).toBe(agentId);
    // The same string, not merely the same instant: the two are compared as strings
    // wherever they meet, and a difference in precision is a difference.
    expect(connection.expires_at).toBe(registration.expires_at);
    expect(Math.floor(Date.parse(connection.expires_at) / 1000))
      .toBe(Math.floor(Date.parse(registration.expires_at) / 1000));
    // And the execution was handed the same one.
    const jobEnvironment = Object.fromEntries(provisioner.jobRuns[0]!.env.map((entry) => [entry.name, entry.value]));
    expect(jobEnvironment.AGENT_EXPIRES_AT).toBe(registration.expires_at);

    // The Bridge is off by default, so no binding exists to carry a third copy.
    const bridgeView = createFirestoreDocumentStore(shared, 'google-bridge');
    expect(await bridgeView.listAll('agent_bindings')).toEqual([]);
  });
});
