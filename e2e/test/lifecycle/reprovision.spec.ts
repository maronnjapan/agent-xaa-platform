import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createAgentRegistration } from '@xaa/provisioner/src/agent/registration';
import { loadDomain } from '@xaa/lifecycle-manager/src/domain';
import { createLifecycleHarness, seedDomain } from '@xaa/lifecycle-manager/src/testing/harness';

const HOUR = 3_600_000;
const NEW_AGENT_ID = 'agent-nnnnnnnnnnnnnnnnnnnnnnnnnn';

/**
 * A permission change, from the request to the two agents it leaves behind — one gone
 * and one new.
 *
 * The Provisioner is represented by its own registration writer rather than a fixture,
 * so the document the new agent starts from is the one production would write. What the
 * test is watching for is what is *not* carried across: no checkpoint, no instructions,
 * and no extra minute of life.
 */
async function reprovisioned(options: { expiresAt?: string } = {}) {
  const shared = createFirestoreDouble();
  const provisionerStore = createFirestoreDocumentStore(shared, 'provisioner');
  const runtimeStore = createFirestoreDocumentStore(shared, 'agent-runtime');
  const harness = createLifecycleHarness({ shared, newAgentId: NEW_AGENT_ID });

  // The Provisioner, answering the internal reprovision call the way it really does:
  // a fresh id, a fresh registration, and the inherited deadline unchanged.
  harness.deps.provisioner.reprovision = async ({ body }) => {
    await createAgentRegistration(provisionerStore, {
      agent_id: NEW_AGENT_ID,
      human_subject: String(body.human_subject),
      client_auth: {
        method: 'client_assertion_jwt', jwk_thumbprint: 'new-thumb',
        public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
      idp_connection_id: `idpconn-${NEW_AGENT_ID}`,
      allowed_audiences: ['https://resource-docs-as.test'],
      resources: ['https://resource-docs-api.test'],
      scopes: ['docs.read'],
      trusted_resource_as: ['https://resource-docs-as.test'],
      created_at: new Date().toISOString(),
      expires_at: String(body.inherited_expires_at),
      status: 'ACTIVE',
      dedicated_op: null,
      isolation_level: 'standard',
      job_execution_name: null,
    });
    return { status: 201, body: { agent_id: NEW_AGENT_ID } };
  };

  const expiresAt = options.expiresAt ?? new Date(Date.now() + HOUR).toISOString();
  const oldAgentId = await seedDomain(harness, { expiresAt });
  // What the old agent had been doing, and what it had been told.
  await runtimeStore.set('agents', `${oldAgentId}__state`, {
    agent_status: 'RUNNING', conversation_context: ['half-finished work'],
  });
  await runtimeStore.set('agent_instructions', 'ins-1', { agent_id: oldAgentId, text: 'carry on', applied_at: null });

  const response = await harness.fetch(`/internal/agents/${oldAgentId}/reprovision`, {
    method: 'POST',
    headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      effective_capabilities: ['document.read'],
      required_capabilities: ['document.read'],
      work_definition_id: 'wd_1',
    }),
  });
  return { harness, runtimeStore, oldAgentId, expiresAt, response };
}

describe('re-provisioning after a permission change', () => {
  it('new agent starts with empty state and the old registration is gone', async () => {
    const { harness, runtimeStore, oldAgentId, expiresAt, response } = await reprovisioned();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'reprovisioned', new_agent_id: NEW_AGENT_ID });

    // agents/{old_id} is not in Firestore at all — not marked, not archived, gone.
    for (const part of ['meta', 'state', 'instructions', 'manifest']) {
      expect(await harness.documents.get('agents', `${oldAgentId}__${part}`)).toBeUndefined();
    }
    expect(await runtimeStore.queryEqual('agent_instructions', [['agent_id', oldAgentId]])).toEqual([]);

    // agents/{new_id}/state is empty: no checkpoint was moved across, so the new agent
    // cannot resume work the old one was no longer permitted to do.
    expect(await harness.documents.get('agents', `${NEW_AGENT_ID}__state`)).toBeUndefined();
    expect(await runtimeStore.queryEqual('agent_instructions', [['agent_id', NEW_AGENT_ID]])).toEqual([]);

    // The replacement exists, with the deadline it inherited rather than a new one.
    const domain = await loadDomain(harness.documents, NEW_AGENT_ID);
    expect(domain.expires_at).toBe(expiresAt);
    expect(domain.status).toBe('ACTIVE');
    expect(JSON.stringify(harness.provisionerCalls)).not.toContain('half-finished work');
  });

  it('creates nothing when the inherited deadline has already passed', async () => {
    const { harness, oldAgentId, response } = await reprovisioned({
      expiresAt: new Date(Date.now() - HOUR).toISOString(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'aborted', reason_code: 'reprovision_expired' });
    // The old agent is still destroyed: a permission change never leaves it running.
    expect(await harness.documents.get('agents', `${oldAgentId}__meta`)).toBeUndefined();
    expect(await harness.documents.get('agents', `${NEW_AGENT_ID}__meta`)).toBeUndefined();
    expect(harness.provisionerCalls).toHaveLength(0);
  });
});
