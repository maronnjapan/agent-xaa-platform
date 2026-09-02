import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createAgentRegistration } from '@xaa/provisioner/src/agent/registration';
import { loadDomain, DOMAIN_SUBDOCUMENTS, deleteDomain } from '@xaa/lifecycle-manager/src/domain';

/**
 * One record, written by one service and read by another.
 *
 * The Agent Identity Domain is the reason cleanup can enumerate everything belonging to
 * an agent from a single read (RULE-27, RULE-41). That only holds if the two ends agree
 * on the shape, and the way to know they agree is to have the Provisioner's own writer
 * produce the document and the Lifecycle Manager's own reader consume it — not to
 * hand-write a fixture that matches whichever of the two was edited last.
 */
const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

function stores() {
  const firestore = createFirestoreDouble();
  return {
    provisioner: createFirestoreDocumentStore(firestore, 'provisioner'),
    lifecycle: createFirestoreDocumentStore(firestore, 'lifecycle-manager'),
  };
}

async function provision(options: { isolationLevel?: 'standard' | 'full_isolation'; dedicatedOp?: string | null } = {}) {
  const { provisioner, lifecycle } = stores();
  await createAgentRegistration(provisioner, {
    agent_id: AGENT_ID,
    human_subject: 'testuser',
    client_auth: {
      method: 'client_assertion_jwt',
      jwk_thumbprint: 'thumb',
      public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    },
    idp_connection_id: `idpconn-${AGENT_ID}`,
    allowed_audiences: ['https://resource-docs-as.test'],
    resources: ['https://resource-docs-api.test'],
    scopes: ['docs.read'],
    trusted_resource_as: ['https://resource-docs-as.test'],
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-02T00:00:00.000Z',
    status: 'ACTIVE',
    dedicated_op: options.dedicatedOp ?? null,
    isolation_level: options.isolationLevel ?? 'standard',
    job_execution_name: null,
  });
  return { provisioner, lifecycle };
}

describe('the agent identity domain across the two services', () => {
  it('provisioner writes a domain that lifecycle can load', async () => {
    const { lifecycle } = await provision();

    // No error, and none of the defaults invented: what the Provisioner omitted is
    // filled in as empty, not guessed at.
    const domain = await loadDomain(lifecycle, AGENT_ID);
    expect(domain).toMatchObject({
      agent_id: AGENT_ID,
      human_subject: 'testuser',
      isolation_level: 'standard',
      dedicated_op: null,
      job_execution_name: null,
      idp_connection_id: `idpconn-${AGENT_ID}`,
      status: 'ACTIVE',
    });
    expect(domain.bridge_binding_ids).toEqual([]);
    expect(domain.cleanup_step_results).toEqual([]);
    // Nothing an agent must not know travelled with it (RULE-16 / RULE-46).
    for (const forbidden of ['issuer', 'subject', 'api_base_url', 'tool_id', 'refresh_token']) {
      expect(domain).not.toHaveProperty(forbidden);
    }
  });

  it('reads a full_isolation record with its dedicated OP', async () => {
    const { lifecycle } = await provision({
      isolationLevel: 'full_isolation', dedicatedOp: 'https://dedicated-op-abcdefghijkl.test',
    });
    await expect(loadDomain(lifecycle, AGENT_ID)).resolves.toMatchObject({
      isolation_level: 'full_isolation', dedicated_op: 'https://dedicated-op-abcdefghijkl.test',
    });
  });

  it('deletes every sub-document the two services wrote', async () => {
    const { provisioner, lifecycle } = await provision();
    await provisioner.set('agents', `${AGENT_ID}__manifest`, { tools: [] });
    await provisioner.set('agents', `${AGENT_ID}__state`, { agent_status: 'ACTIVE' });
    await provisioner.set('agents', `${AGENT_ID}__instructions`, { pending: [] });

    await deleteDomain(lifecycle, AGENT_ID);

    const left = await Promise.all(DOMAIN_SUBDOCUMENTS.map((part) => lifecycle.get('agents', `${AGENT_ID}__${part}`)));
    expect(left.filter((document) => document !== undefined)).toHaveLength(0);
  });
});
