import { describe, expect, it } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { cleanupAgent } from '../src/cleanup/index.js';
import { CLEANUP_REASONS, isAbnormalReason } from '../src/config.js';
import { AUDIT_FIELDS } from '../src/cleanup/steps/audit-persist.js';
import { DOMAIN_SUBDOCUMENTS, FORBIDDEN_DOMAIN_KEYS, deleteDomain, loadDomain, DomainSchemaViolation } from '../src/domain.js';
import { AGENT_OP_URL, createLifecycleHarness, recordingClients, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';
import { createLogger } from '@xaa/logging';
import { DISABLED_ENDPOINT, PLATFORM_ENDPOINT_KEYS, type PlatformEndpoints } from '@xaa/contracts';
import { resolveEndpoints } from '../src/endpoints.js';

const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };

function deps(harness: LifecycleHarness, lines: string[] = []) {
  return {
    documents: harness.documents, clients: harness.clients,
    logger: createLogger('lifecycle-manager', 'provisioner', (line) => lines.push(line)),
    logContext,
  };
}

describe('step1 and step2', () => {
  /**
   * Three endings count as done, not one. Cleanup runs again every sweep, so an
   * execution that was never started, one already cancelled and one that finished on
   * its own must all leave the step behind rather than pinning every later pass on it.
   */
  it('treats NOT_FOUND and already-finished executions as done', async () => {
    const missing = createLifecycleHarness();
    const noExecution = await seedDomain(missing, { jobExecutionName: null });
    expect((await cleanupAgent(noExecution, 'EXPIRED', deps(missing)))
      .results.find((entry) => entry.step === 'runtime_cancel')!.status).toBe('skipped');

    const notFound = createLifecycleHarness();
    notFound.clients.cloudRun.cancelExecution = async () => 'not_found';
    const gone = await seedDomain(notFound);
    expect((await cleanupAgent(gone, 'EXPIRED', deps(notFound)))
      .results.find((entry) => entry.step === 'runtime_cancel')!.status).toBe('skipped');

    const finished = createLifecycleHarness();
    finished.clients.cloudRun.cancelExecution = async () => 'already_finished';
    const done = await seedDomain(finished);
    const outcome = await cleanupAgent(done, 'EXPIRED', deps(finished));
    expect(outcome.results.find((entry) => entry.step === 'runtime_cancel')!.status).toBe('succeeded');
    expect(outcome.status).toBe('DESTROYED');
  });

  /**
   * An execution is the only Cloud Run object this step may touch. The Service and the
   * Job definition are Terraform's; deleting one here would take the platform down to
   * stop a single agent, and Terraform would rebuild it on the next apply.
   */
  it('does not call delete APIs', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteService')).toHaveLength(0);
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteJob')).toHaveLength(0);
  });

  /**
   * A full-isolation agent is registered only at the OP that was built for it, whose
   * address exists nowhere but the record the Provisioner wrote. Asking the shared OP
   * would be answered with a 404 for an agent it never had — which cleanup reads as
   * "already disabled", leaving a live registration on a service nobody checked.
   */
  it('targets the dedicated OP for full_isolation agents', async () => {
    const dedicated = createLifecycleHarness();
    const isolated = await seedDomain(dedicated, { isolationLevel: 'full_isolation' });
    await cleanupAgent(isolated, 'EXPIRED', deps(dedicated));
    expect(dedicated.clients.calls.find((entry) => entry.target === 'disableIssuance')!.baseUrl)
      .toBe('https://dedicated-op-abcdefghijkl.test');

    const standard = createLifecycleHarness();
    const shared = await seedDomain(standard, { isolationLevel: 'standard' });
    await cleanupAgent(shared, 'EXPIRED', deps(standard));
    expect(standard.clients.calls.find((entry) => entry.target === 'disableIssuance')!.baseUrl)
      .toBe(AGENT_OP_URL);
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
  /**
   * One connection, named outright. There is no revoke-by-human-subject call to make,
   * and that is the point: the person's other agents hold their own connections and
   * their browser session rides on the same identity, so a query by subject would take
   * all of them out to stop one agent.
   */
  it('calls agent-op once with the agent\'s connection id only', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const revokes = harness.clients.calls.filter((entry) => entry.target === 'revokeIdpConnection');
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.argument).toBe(`idpconn-${agentId}`);
    expect(revokes[0]!.argument).not.toContain('testuser');
  });

  /**
   * `sa-lifecycle` holds no permission on the connection-encryption key (DEC-IAC-08),
   * so the refresh token is decrypted inside the Agent OP and never crosses into this
   * service. A KMS call from here would mean that separation had quietly been undone.
   */
  it('never calls KMS decrypt', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(Object.keys(harness.clients.kms)).toEqual(['destroyCryptoKeyVersion']);
    expect(harness.clients.calls.filter((entry) => entry.target === 'destroyCryptoKeyVersion')).toHaveLength(0);
    expect(harness.clients.calls.filter((entry) => entry.target.toLowerCase().includes('decrypt'))).toHaveLength(0);
  });

  /**
   * RULE-51 in one assertion: the refresh token lives at the Agent OP and nowhere else.
   * The two tests above split this into its halves; this is the pairing itself, because
   * the rule is that both hold at once — naming one connection is no protection if this
   * service could decrypt, and refusing to decrypt is no protection if it revoked by
   * subject.
   */
  it('names only this agent connection and never decrypts anything', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const revokes = harness.clients.calls.filter((entry) => entry.target === 'revokeIdpConnection');
    expect(revokes.map((entry) => entry.argument)).toEqual([`idpconn-${agentId}`]);
    expect(harness.clients.calls.filter((entry) => entry.target === 'destroyCryptoKeyVersion')).toHaveLength(0);
  });

  it('treats 404 and null connection id as done', async () => {
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

  /**
   * The upstream refresh token is shared: revoking it at the SaaS breaks the person's
   * connection for every other agent of theirs at once. EXPIRED, USER_STOP and
   * REPROVISION are ordinary endings and must not do that; QUARANTINE and
   * IDENTITY_DISABLED are not, and there the collateral damage is the lesser harm.
   */
  it('calls upstream SaaS revoke only for QUARANTINE and IDENTITY_DISABLED', async () => {
    const expected: Record<string, number> = {
      EXPIRED: 0, USER_STOP: 0, REPROVISION: 0, QUARANTINE: 1, IDENTITY_DISABLED: 1,
    };
    for (const reason of CLEANUP_REASONS) {
      const clients = recordingClients({ bridgeUrl: 'https://bridge.test' });
      const harness = createLifecycleHarness({ clients });
      const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1'] });
      // The Bridge's own side of the contract (T-BRIDGE-18): a successful
      // revoke-upstream leaves the connection REVOKED.
      const connectionId = `idpconn-${agentId}`;
      await harness.documents.set('idp_connections', connectionId, { agent_id: agentId, status: 'ACTIVE' });
      const revokeUpstream = clients.bridge.revokeUpstream.bind(clients.bridge);
      clients.bridge.revokeUpstream = async (input) => {
        const status = await revokeUpstream(input);
        await harness.documents.update('idp_connections', input.connectionId, { status: 'REVOKED' });
        return status;
      };

      await cleanupAgent(agentId, reason, deps(harness));

      const upstream = harness.clients.calls.filter((entry) => entry.target === 'revokeUpstream');
      expect(upstream).toHaveLength(expected[reason]!);
      expect(isAbnormalReason(reason)).toBe(expected[reason] === 1);
      const connection = await harness.documents.get<{ status: string }>('idp_connections', connectionId);
      expect(connection!.status).toBe(expected[reason] === 1 ? 'REVOKED' : 'ACTIVE');
    }
  });

  /**
   * `enable_google_bridge=false` is the default profile, and there step4 has nothing to
   * reach. It must skip rather than fail, or every ordinary cleanup in the default
   * deployment would end one step short of DESTROYED for ever.
   */
  it('skips the bridge step when the bridge is not deployed', async () => {
    // endpoints.json under `enable_google_bridge=false` carries no Bridge address at all.
    const harness = createLifecycleHarness();
    expect(harness.clients.endpoints.bridgeUrl).toBeNull();
    const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1'] });
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'bridge_binding_disable')!.status).toBe('skipped');
    expect(outcome.status).toBe('DESTROYED');
  });

  /**
   * By agent, not by binding: `/bindings/{agent_id}/disable` is the route the Bridge
   * serves, and the per-binding path this used to call was never one of them (00b §4).
   */
  it('disables the agent\'s bindings when the bridge is deployed, then deletes them', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ bridgeUrl: 'https://bridge.test' }) });
    const agentId = await seedDomain(harness, { bridgeBindingIds: ['bind-1', 'bind-2'] });

    await cleanupAgent(agentId, 'EXPIRED', deps(harness));

    expect(harness.clients.calls.filter((entry) => entry.target === 'disableBindings').map((entry) => entry.argument))
      .toEqual([agentId]);
    expect(harness.clients.calls.filter((entry) => entry.target === 'deleteBindings').map((entry) => entry.argument))
      .toEqual([agentId]);
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

  /**
   * Every standard agent signs with the one shared ID-JAG key. Disabling or destroying a
   * version of it to clean up a single agent would revoke the whole platform, so this
   * step touches no KMS API at all — neither `disableCryptoKeyVersion` nor
   * `destroyCryptoKeyVersion`. A dedicated key is a different matter, and step8 has it.
   */
  it('does not disable the shared idjag key for standard agents', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { isolationLevel: 'standard' });
    await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    const kmsCalls = harness.clients.calls
      .filter((entry) => entry.target === 'disableCryptoKeyVersion' || entry.target === 'destroyCryptoKeyVersion');
    expect(kmsCalls).toHaveLength(0);
    // There is no disable API on the client at all: the only KMS verb cleanup has is
    // the destruction schedule step8 uses on a dedicated key.
    expect(Object.keys(harness.clients.kms)).not.toContain('disableCryptoKeyVersion');
  });

  it('audit log has the 11 required fields and no JWT-shaped string', async () => {
    const lines: string[] = [];
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'EXPIRED', deps(harness, lines));
    const audit = lines.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
      .find((entry) => entry.event === 'agent_cleanup_completed')!;
    expect(AUDIT_FIELDS).toHaveLength(11);
    for (const field of AUDIT_FIELDS) expect(Object.keys(audit.fields)).toContain(field);
    for (const line of lines) expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\./);
  });

  it('each tail step is skipped when the target is already gone', async () => {
    const harness = createLifecycleHarness({ clients: recordingClients({ statusFor: { revokeClientCredential: 404, deleteRegistration: 404 } }) });
    const agentId = await seedDomain(harness);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.results.find((entry) => entry.step === 'client_credential_revoke')!.status).toBe('skipped');
    expect(outcome.results.find((entry) => entry.step === 'runtime_state_delete')!.status).toBe('skipped');
    expect(outcome.status).toBe('DESTROYED');
  });
});

describe('the agent identity domain', () => {
  it('rejects standard with dedicated resources / rejects full_isolation without dedicated resources', async () => {
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

  /**
   * Four documents, not one. `state` holds the checkpoint, `instructions` what a person
   * last told the agent, `manifest` what it was allowed to reach, and `meta` the record
   * itself — deleting `meta` alone would leave three documents describing an agent that
   * no longer exists, and nothing that would ever come back for them.
   */
  it('deleteDomain removes state, instructions, manifest and meta', async () => {
    const shared = createFirestoreDouble();
    const harness = createLifecycleHarness({ shared });
    const agentId = await seedDomain(harness);
    for (const part of ['state', 'instructions', 'manifest'] as const) {
      await harness.provisionerStore.set('agents', `${agentId}__${part}`, { written: part });
    }
    for (const part of DOMAIN_SUBDOCUMENTS) {
      expect(await harness.documents.get('agents', `${agentId}__${part}`)).toBeDefined();
    }

    await deleteDomain(harness.documents, agentId);

    // Nothing at all is left under agents/{agent_id}: the count, not a sample of it.
    const left = await Promise.all(DOMAIN_SUBDOCUMENTS.map((part) => harness.documents.get('agents', `${agentId}__${part}`)));
    expect(left.filter((document) => document !== undefined)).toHaveLength(0);
    expect(DOMAIN_SUBDOCUMENTS).toEqual(['meta', 'state', 'instructions', 'manifest']);
  });

  it('reads a record the Provisioner wrote', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await expect(loadDomain(harness.documents, agentId)).resolves.toMatchObject({
      agent_id: agentId, isolation_level: 'standard', bridge_binding_ids: [],
    });
  });
});

/**
 * `enable_google_bridge=false` is the default deployment, and endpoints.json spells the
 * missing Bridge as a URI because the schema has no way to say "absent". Reading that
 * URI as a destination made step5 send a real request to a host that does not resolve,
 * so every quarantine and every disabled identity ended in a failed cleanup.
 */
describe('where the other services are', () => {
  function endpoints(overrides: Partial<PlatformEndpoints> = {}): PlatformEndpoints {
    const base = Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [
      key,
      key === 'agent_max_lifetime_seconds' ? 3600
        : key === 'enable_google_bridge' ? false
        : key === 'vertex_model' || key === 'vertex_location' ? 'test'
        : `https://${key.replaceAll('_', '-')}.test`,
    ])) as unknown as PlatformEndpoints;
    return { ...base, xaa_token_url: 'https://shared-agent-op.test/xaa/token', ...overrides };
  }

  it('reads the disabled sentinel as no Bridge at all', () => {
    const resolved = resolveEndpoints(endpoints({ bridge_internal_url: DISABLED_ENDPOINT }));
    expect(resolved.bridgeUrl).toBeNull();
  });

  it('keeps a real Bridge url', () => {
    const resolved = resolveEndpoints(endpoints({ bridge_internal_url: 'https://google-bridge.test' }));
    expect(resolved.bridgeUrl).toBe('https://google-bridge.test');
    expect(resolved.agentOpUrl).toBe('https://shared-agent-op.test');
  });

  it('leaves the abnormal-reason cleanup free of a Bridge call when there is none', async () => {
    const harness = createLifecycleHarness();
    harness.clients.endpoints.bridgeUrl = null;
    const agentId = await seedDomain(harness);

    const outcome = await cleanupAgent(agentId, 'IDENTITY_DISABLED', deps(harness));

    expect(outcome.results.find((entry) => entry.step === 'credential_revoke')!.status).toBe('succeeded');
    expect(harness.clients.calls.map((call) => call.target)).not.toContain('revokeUpstream');
  });
});
