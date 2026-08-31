import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { cleanupAgent } from '../src/cleanup/index.js';
import { CLEANUP_REASONS, isAbnormalReason } from '../src/config.js';
import { AUDIT_FIELDS } from '../src/cleanup/steps/audit-persist.js';
import { DOMAIN_SUBDOCUMENTS, FORBIDDEN_DOMAIN_KEYS, loadDomain, DomainSchemaViolation } from '../src/domain.js';
import { createLifecycleHarness, recordingClients, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';
import { createLogger } from '@xaa/logging';

const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };

function deps(harness: LifecycleHarness, lines: string[] = []) {
  return {
    documents: harness.documents, clients: harness.clients,
    logger: createLogger('lifecycle-manager', 'provisioner', (line) => lines.push(line)),
    logContext,
  };
}

describe('step1 and step2', () => {
  it('treats a missing execution as done and never deletes a service or job', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { jobExecutionName: null });
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'runtime_cancel')!.status).toBe('skipped');
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteService')).toHaveLength(0);
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteJob')).toHaveLength(0);
  });

  it('cancels the execution named in the record, unchanged', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(harness.clients.calls.find((entry) => entry.target === 'cancelExecution')!.argument)
      .toBe('projects/xaa-test/locations/asia-northeast1/jobs/agent-runtime-standard/executions/exec-1');
  });

  it('treats a 404 from the OP as already disabled', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ statusFor: { disableIssuance: 404 } }) });
    const agentId = await seedDomain(harness);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'issuance_disable')!.status).toBe('skipped');
  });

  it('retries a 5xx rather than accepting it', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ statusFor: { disableIssuance: 503 } }) });
    const agentId = await seedDomain(harness);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'issuance_disable')!.status).toBe('failed');
  });
});

describe('step3, the IdP connection', () => {
  it('names only this agent connection and never decrypts anything', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const revokes = harness.clients.calls.filter((entry) => entry.target === 'revokeIdpConnection');
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.argument).toBe(`idpconn-${agentId}`);
    // No KMS call of any kind: the key belongs to the Agent OP (DEC-IAC-08).
    expect(harness.clients.calls.filter((entry) => entry.target === 'destroyCryptoKeyVersion')).toHaveLength(0);
  });

  it('treats a null connection id and a 404 alike', async () => {
    const withoutConnection = createLifecycleHarness();
    const first = await seedDomain(withoutConnection, { idpConnectionId: null });
    const outcome = await cleanupAgent(first, 'EXPIRED', deps(withoutConnection));
    expect(outcome.results.find((entry) => entry.step === 'idp_connection_revoke')!.status).toBe('skipped');

    const gone = createLifecycleHarness({ clients: recordingClients({ statusFor: { revokeIdpConnection: 404 } }) });
    const second = await seedDomain(gone);
    const secondOutcome = await cleanupAgent(second, 'EXPIRED', deps(gone));
    expect(secondOutcome.results.find((entry) => entry.step === 'idp_connection_revoke')!.status).toBe('skipped');
  });
});

describe('step4 and step5, the credentials already issued', () => {
  it('calls revoke-by-actor on both resource AS for every reason', async () => {
    for (const reason of CLEANUP_REASONS) {
      const harness = createLifecycleHarness();
      const agentId = await seedDomain(harness);
      await cleanupAgent(agentId, reason, deps(harness));
      const calls = harness.clients.calls.filter((entry) => entry.target === 'revokeByActor');
      expect(calls).toHaveLength(2);
      expect(calls.map((entry) => entry.argument.split('|')[0]).sort())
        .toEqual(['https://resource-docs-as.test', 'https://resource-finance-as.test']);
    }
  });

  it('sends actor_sub in urn:xaa:agent form and never the human subject', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const call = harness.clients.calls.find((entry) => entry.target === 'revokeByActor')!;
    expect(call.argument.split('|')[1]).toBe(`urn:xaa:agent:${agentId}`);
    expect(call.argument).not.toContain('testuser');
  });

  it('calls the second resource AS even when the first fails', async () => {
    const harness = createLifecycleHarness({
      clients: recordingClients({ statusFor: { 'revokeByActor:https://resource-docs-as.test': 503 } }),
    });
    const agentId = await seedDomain(harness);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(harness.clients.calls.filter((entry) => entry.target === 'revokeByActor')).toHaveLength(2);
    expect(outcome.results.find((entry) => entry.step === 'credential_revoke')!.status).toBe('failed');
  });

  it('calls upstream SaaS revoke only for QUARANTINE and IDENTITY_DISABLED', async () => {
    for (const reason of CLEANUP_REASONS) {
      const harness = createLifecycleHarness({ clients: recordingClients({ bridgeUrl: 'https://bridge.test' }) });
      const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1'] });
      await cleanupAgent(agentId, reason, deps(harness));
      const upstream = harness.clients.calls.filter((entry) => entry.target === 'revokeUpstream');
      expect(upstream).toHaveLength(isAbnormalReason(reason) ? 1 : 0);
    }
  });

  it('skips the bridge step when the bridge is not deployed', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1'] });
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'bridge_binding_disable')!.status).toBe('skipped');
    expect(outcome.status).toBe('DESTROYED');
  });

  it('disables each binding when the bridge is deployed', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ bridgeUrl: 'https://bridge.test' }) });
    const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1', 'bind-2'] });
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(harness.clients.calls.filter((entry) => entry.target === 'disableBinding').map((entry) => entry.argument))
      .toEqual(['bind-1', 'bind-2']);
  });
});

describe('the tail steps', () => {
  it('leaves nothing under agents/{agent_id} after step11', async () => {
    const shared = createFirestoreDouble();
    const harness = createLifecycleHarness({ shared });
    const agentId = await seedDomain(harness);
    const runtime = (await import('@xaa/gcp')).createFirestoreDocumentStore(shared, 'agent-runtime');
    await runtime.set('agents', `${agentId}__state`, { agent_status: 'ACTIVE' });
    await runtime.set('agent_instructions', 'ins-1', { agent_id: agentId, text: 'x', applied_at: null });
    await harness.provisionerStore.set('agents', `${agentId}__manifest`, { tools: [] });

    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    for (const part of DOMAIN_SUBDOCUMENTS) {
      expect(await harness.documents.get('agents', `${agentId}__${part}`)).toBeUndefined();
    }
    expect(await harness.documents.queryEqual('agent_instructions', [['agent_id', agentId]])).toEqual([]);
  });

  it('does not disable the shared idjag key for standard agents', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { isolationLevel: 'standard' });
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(harness.clients.calls.filter((entry) => entry.target === 'destroyCryptoKeyVersion')).toHaveLength(0);
  });

  it('audit log has the required fields and no JWT-shaped string', async () => {
    const lines: string[] = [];
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness, lines));
    const audit = lines.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
      .find((entry) => entry.event === 'agent_cleanup_completed')!;
    for (const field of AUDIT_FIELDS) expect(Object.keys(audit.fields)).toContain(field);
    for (const line of lines) expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./);
  });

  it('skips each tail step when the target is already gone', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ statusFor: { revokeClientCredential: 404, deleteRegistration: 404 } }) });
    const agentId = await seedDomain(harness);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'client_credential_revoke')!.status).toBe('skipped');
    expect(outcome.results.find((entry) => entry.step === 'runtime_state_delete')!.status).toBe('skipped');
    expect(outcome.status).toBe('DESTROYED');
  });
});

describe('the agent identity domain', () => {
  it('rejects standard with a dedicated OP and full_isolation without one', async () => {
    const harness = createLifecycleHarness();
    await harness.provisionerStore.set('agents', 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa__meta', {
      agent_id: 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa', human_subject: 'testuser', isolation_level: 'standard',
      dedicated_op: 'https://dedicated-op-abcdefghijkl.test', job_execution_name: null, idp_connection_id: null,
      created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z', status: 'ACTIVE',
    });
    await expect(loadDomain(harness.documents, 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(DomainSchemaViolation);

    await harness.provisionerStore.set('agents', 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb__meta', {
      agent_id: 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb', human_subject: 'testuser', isolation_level: 'full_isolation',
      dedicated_op: null, job_execution_name: null, idp_connection_id: null,
      created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-02T00:00:00.000Z', status: 'ACTIVE',
    });
    await expect(loadDomain(harness.documents, 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toThrow(DomainSchemaViolation);
  });

  it('refuses a record carrying anything an agent must not know', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    for (const forbidden of FORBIDDEN_DOMAIN_KEYS) {
      const meta = await harness.documents.get('agents', `${agentId}__meta`);
      await harness.provisionerStore.set('agents', `${agentId}__meta`, { ...meta, [forbidden]: 'x' });
      await expect(loadDomain(harness.documents, agentId)).rejects.toThrow(DomainSchemaViolation);
    }
  });

  it('reads a record the Provisioner wrote', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await expect(loadDomain(harness.documents, agentId)).resolves.toMatchObject({
      agent_id: agentId, isolation_level: 'standard', bridge_binding_ids: [],
    });
  });
});
