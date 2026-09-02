import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import * as registration from '../src/agent/registration.js';

/**
 * docs 07 §5 and §7, as a shape rather than as a habit: an agent is replaced, never
 * amended (RULE-29, RULE-13).
 *
 * A registration is the record of what a person delegated. Editing one turns an
 * authority the person agreed to into a different authority they did not, and does so
 * without producing anything to review afterwards — the old values are simply gone.
 * Re-provisioning leaves both records instead, joined by `replaces_agent_id`.
 *
 * The constraint is enforced twice: no exported function takes those fields, and the
 * one update path refuses them by name.
 */
describe('what may be written to a registration after it exists', () => {
  const store = () => createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');

  it('exports exactly the create, update and delete surface, and nothing that amends authority', () => {
    expect(Object.keys(registration).filter((name) => typeof (registration as Record<string, unknown>)[name] === 'function').sort())
      .toEqual([
        'AgentAlreadyExists',
        'ForbiddenRegistrationWrite',
        'createAgentRegistration',
        'deleteAgentManifest',
        'deleteAgentRegistration',
        'setJobExecutionName',
        'setProvisioningStatus',
        'updateRegistrationFields',
        'writeAgentManifest',
      ]);
    // Two of those write the manifest sub-document rather than the registration; the
    // registration itself is created, moved through its status, given an execution
    // name, and deleted. There is no `updateRegistration`, no `setScopes` and no
    // `extendExpiry`, and the list above fails if one appears.
    expect(registration.MUTABLE_REGISTRATION_FIELDS).toEqual(['status', 'job_execution_name']);
  });

  it('refuses to update the scopes', async () => {
    await expect(registration.updateRegistrationFields(store(), 'agent-abcdefghijklmnopqrstuvwxyz', {
      scopes: ['docs.read', 'docs.write'],
    })).rejects.toThrow(registration.ForbiddenRegistrationWrite);
  });

  it('refuses every other field that carries authority or identity', async () => {
    for (const field of ['allowed_audiences', 'resources', 'expires_at', 'human_subject', 'client_auth', 'dedicated_op']) {
      const rejected = registration.updateRegistrationFields(store(), 'agent-abcdefghijklmnopqrstuvwxyz', { [field]: 'x' });
      await expect(rejected).rejects.toThrow('forbidden_registration_write');
    }
  });

  it('lets the two bookkeeping fields through', async () => {
    const documents = store();
    await registration.createAgentRegistration(documents, {
      agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
      human_subject: 'testuser',
      client_auth: { method: 'client_assertion_jwt', jwk_thumbprint: 'tp', public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
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
    });
    await registration.setJobExecutionName(documents, 'agent-abcdefghijklmnopqrstuvwxyz', 'jobs/x/executions/y');
    await registration.setProvisioningStatus(documents, 'agent-abcdefghijklmnopqrstuvwxyz', 'ACTIVE');
    const stored = await documents.get<{ status: string; job_execution_name: string; scopes: string[] }>(
      'agents', 'agent-abcdefghijklmnopqrstuvwxyz__meta',
    );
    expect(stored!.status).toBe('ACTIVE');
    expect(stored!.job_execution_name).toBe('jobs/x/executions/y');
    expect(stored!.scopes).toEqual(['docs.read']);
  });

  /**
   * The status a registration may move to is one table, and it lives in Lifecycle
   * (00b §1 gives it the nine values). A revoked agent does not come back: it is
   * destroyed, and a replacement is provisioned with its own key and its own consent.
   */
  it('cannot write a status that only Lifecycle owns', async () => {
    // The Provisioner writes three of the nine states (00b §1). REVOKED and EXPIRED
    // are Lifecycle's, and the way back from them — REVOKED to ACTIVE — is refused by
    // its table (`apps/lifecycle-manager/test/state-machine.spec.ts::rejects backward
    // transitions`). Here the point is narrower and belongs to this app: no path from
    // the Provisioner can put an agent into one of those states in the first place.
    expect(registration.agentRegistrationSchema.properties.status.enum).toEqual(['CREATED', 'PROVISIONING', 'ACTIVE']);
    const documents = store();
    await expect(registration.updateRegistrationFields(documents, 'agent-abcdefghijklmnopqrstuvwxyz', {
      status: 'REVOKED', expires_at: '2026-03-01T00:00:00.000Z',
    })).rejects.toThrow('forbidden_registration_write');
  });
});
