import { beforeAll, describe, expect, it } from 'vitest';
import { SchemaValidationError } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { AgentAlreadyExists, createAgentRegistration, type ProvisionedRegistration } from '../src/agent/registration.js';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type TokenIssuer } from './helpers.js';

/**
 * RULE-03 / RULE-31. Every agent gets its own registration, whatever its isolation
 * level. STANDARD shares one Cloud Run process; it does not share an identity.
 *
 * That is the whole difference between the two levels as far as identity goes, and it
 * is worth stating as a test because "standard" reads like "shared": two STANDARD
 * agents made in the same minute still have different ids, different keys and
 * different connections, and a token minted by one is useless to the other.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

function registration(overrides: Partial<ProvisionedRegistration> = {}): ProvisionedRegistration {
  return {
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    human_subject: 'testuser',
    client_auth: {
      method: 'client_assertion_jwt', jwk_thumbprint: 'tp',
      public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    },
    idp_connection_id: 'idpconn-agent-abcdefghijklmnopqrstuvwxyz',
    allowed_audiences: ['https://resource-docs-as.test'],
    resources: ['https://resource-docs-api.test'],
    scopes: ['docs.read'],
    trusted_resource_as: ['https://resource-docs-as.test'],
    created_at: '2026-03-01T00:00:00.000Z',
    expires_at: '2026-03-01T08:00:00.000Z',
    status: 'PROVISIONING',
    dedicated_op: null,
    isolation_level: 'standard',
    job_execution_name: null,
    ...overrides,
  };
}

const store = () => createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');

describe('creating an agent registration', () => {
  it('refuses a document missing a required field, and writes nothing', async () => {
    const documents = store();
    const { scopes, ...incomplete } = registration();
    expect(scopes).toBeDefined();
    await expect(createAgentRegistration(documents, incomplete as ProvisionedRegistration))
      .rejects.toThrow(SchemaValidationError);
    expect(await documents.listAll('agents')).toEqual([]);
  });

  it('refuses an unknown field, and writes nothing', async () => {
    const documents = store();
    await expect(createAgentRegistration(documents, { ...registration(), api_base_url: 'https://x.test' } as ProvisionedRegistration))
      .rejects.toThrow(SchemaValidationError);
    expect(await documents.listAll('agents')).toEqual([]);
  });

  it('refuses a second registration for the same id and leaves the first untouched', async () => {
    const documents = store();
    await createAgentRegistration(documents, registration());
    // Not an upsert: the second caller believes it is creating an agent, and silently
    // overwriting the first would hand two executions the same identity while only one
    // of them holds the key the registration names.
    await expect(createAgentRegistration(documents, registration({ human_subject: 'someone-else' })))
      .rejects.toThrow(AgentAlreadyExists);
    const stored = await documents.get<{ human_subject: string }>('agents', 'agent-abcdefghijklmnopqrstuvwxyz__meta');
    expect(stored!.human_subject).toBe('testuser');
  });

  it('gives two STANDARD agents their own registration, key and connection', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const agents: string[] = [];
    for (const task of ['a', 'b']) {
      const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
      const response = await issuer.provision(target, { decision_id: decisionId, task_id: task, requested_lifetime_minutes: 480 });
      expect(response.status).toBe(201);
      agents.push((await response.json() as { agent_id: string }).agent_id);
    }

    const metas = (await target.documents.listAll<{
      agent_id: string; idp_connection_id: string; client_auth: { jwk_thumbprint: string }; isolation_level: string;
    }>('agents')).filter((row) => row.id.endsWith('__meta'));
    expect(metas).toHaveLength(2);
    expect(new Set(metas.map((row) => row.data.agent_id))).toEqual(new Set(agents));
    expect(new Set(metas.map((row) => row.data.client_auth.jwk_thumbprint)).size).toBe(2);
    expect(new Set(metas.map((row) => row.data.idp_connection_id)).size).toBe(2);
    expect(metas.every((row) => row.data.isolation_level === 'standard')).toBe(true);
  });

  /**
   * The Agent OP reads registrations out of the same collection, through its own
   * app-scoped view. A registration that the Provisioner could write but the OP could
   * not read would leave every token exchange failing for an agent that looks healthy.
   */
  it('writes a registration the Agent OP can read back', async () => {
    const shared = createFirestoreDouble();
    const target = await createProvisionerHarness({ shared, idpPublicJwk: issuer.publicJwk });
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480 });
    const { agent_id: agentId } = await response.json() as { agent_id: string };

    const agentOpView = createFirestoreDocumentStore(shared, 'agent-op');
    const read = await agentOpView.get<{ agent_id: string; scopes: string[]; status: string }>('agents', `${agentId}__meta`);
    expect(read).toBeDefined();
    expect(read!.agent_id).toBe(agentId);
    expect(read!.scopes).toEqual(['docs.read']);
    expect(read!.status).toBe('ACTIVE');
  });
});
