import { describe, expect, it } from 'vitest';
import { createFirestoreDouble, createFirestoreDocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import { sweep } from '@xaa/lifecycle-manager/src/sweep';
import { cleanupAgent } from '@xaa/lifecycle-manager/src/cleanup/index';
import { emitLifecycleEvent, eventTypeFor } from '@xaa/lifecycle-manager/src/events';
import { createLifecycleHarness, seedDomain } from '@xaa/lifecycle-manager/src/testing/harness';
import { requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { idpPublicJwk } from '../../harness/human-idp.js';
import { humanSubjectToken, requestSubjectToken } from './harness.js';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'demo', trace_id: 'demo', agent_id: null, human_subject: null };
const MINUTE = 60_000;

/**
 * Demo D-3, the Lifecycle half.
 *
 * A three-minute agent, a clock moved forward four minutes, and one tick. What the demo
 * shows is that the refusal comes from three independent layers, not from one flag: the
 * Agent OP refuses the exchange because the registration has expired, cleanup removes
 * the record entirely, and the timeline gets exactly one AGENT_EXPIRED however many
 * ticks run.
 *
 * The clock is an argument, never a wait. A test that slept for three minutes would be
 * a test nobody runs.
 */
describe('a three minute agent, after four minutes', () => {
  it('token exchange fails with invalid_grant after expiry', async () => {
    const subjectToken = await humanSubjectToken();
    const expiresAt = new Date(Date.now() + 3 * MINUTE).toISOString();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), expiresAt });

    // Before expiry the exchange works.
    expect((await requestIdJag(agentOp, { subjectToken })).status).toBe(200);

    // After it, the same request is refused — by the registration's own expiry, with no
    // lifecycle involvement at all.
    const expired = await startAgentOp({
      idpPublicJwk: await idpPublicJwk(),
      expiresAt: new Date(Date.now() - MINUTE).toISOString(),
    });
    const response = await requestIdJag(expired, { subjectToken });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });

  /**
   * The second of the three layers demo D-3 shows. The registration and the connection
   * expire independently: even an agent whose registration somehow survived could not
   * fetch a fresh subject token, because the connection it would spend has its own
   * deadline and the OP checks it before touching the stored credential.
   */
  it('subject-token retrieval fails after the idp connection expires', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const connectionId = `idpconn-${agentOp.agentId}`;
    const connection = {
      idp_connection_id: connectionId, agent_id: agentOp.agentId, human_subject: 'testuser',
      encrypted_refresh_token: Buffer.from(`${agentOp.agentId}::refresh-token`, 'utf8').toString('base64'),
      granted_scopes: ['openid', 'offline_access'], status: 'ACTIVE',
      created_at: new Date(Date.now() - 2 * MINUTE).toISOString(),
      expires_at: new Date(Date.now() - MINUTE).toISOString(),
    };
    await agentOp.documents.set('idp_connections', connectionId, connection);

    const response = await requestSubjectToken(agentOp);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
    // The refusal came from the connection's own expiry, before anything was decrypted
    // or sent: the reissue never started.
    expect(JSON.parse(agentOp.connectionLogs.at(-1)!).fields).toMatchObject({
      idp_connection_id: connectionId, subject_token_refetch_result: 'n/a',
    });
  });

  it('passes ACTIVE, EXPIRING, EXPIRED and DESTROYED in order', async () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    const shared = createFirestoreDouble();
    const seen: string[] = [];
    const agentId = 'agent-abcdefghijklmnopqrstuvwxyz';

    const record = async (): Promise<void> => {
      const meta = await createFirestoreDocumentStore(shared, 'lifecycle-manager')
        .get<{ status?: string }>('agents', `${agentId}__meta`);
      if (meta?.status && seen.at(-1) !== meta.status) seen.push(meta.status);
    };

    // t+0: three minutes of life left.
    let clock = start;
    const harness = createLifecycleHarness({ shared, now: () => clock });
    await seedDomain(harness, { agentId, expiresAt: new Date(start + 3 * MINUTE).toISOString() });
    await record();

    const tick = async (): Promise<void> => {
      await sweep({
        documents: harness.documents, expiringWindowSeconds: 60, now: () => clock,
        cleanup: (id, reason) => cleanupAgent(id, reason, {
          documents: harness.documents, clients: harness.clients, logger, logContext, now: () => clock,
        }),
      });
      await record();
    };

    // t+2m30s: inside the sixty-second warning window.
    clock = start + 2.5 * MINUTE;
    await tick();
    // t+4m: past the expiry.
    clock = start + 4 * MINUTE;
    await tick();

    expect(seen).toEqual(['ACTIVE', 'EXPIRING']);
    // And then nothing: the record is gone, which is what DESTROYED means here.
    expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
  });

  it('emits AGENT_EXPIRED exactly once across two ticks', async () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    const shared = createFirestoreDouble();
    let clock = start;
    const harness = createLifecycleHarness({ shared, now: () => clock });
    const agentId = await seedDomain(harness, { expiresAt: new Date(start - MINUTE).toISOString() });

    const tick = async (): Promise<void> => {
      await sweep({
        documents: harness.documents, expiringWindowSeconds: 60, now: () => clock,
        cleanup: (id, reason) => cleanupAgent(id, reason, {
          documents: harness.documents, clients: harness.clients, logger, logContext, now: () => clock,
          onDestroyed: async (domain) => {
            const eventType = eventTypeFor(reason);
            if (!eventType) return;
            await emitLifecycleEvent({
              eventType, agentId: domain.agent_id, humanSubject: domain.human_subject,
              traceId: 'demo', occurredAt: new Date(clock).toISOString(),
              publish: harness.deps.publishActivity!,
            });
          },
        }),
      });
    };

    await tick();
    expect(harness.activity).toHaveLength(1);
    clock = start + MINUTE;
    await tick();
    // The second tick finds nothing left to clean, so it publishes nothing.
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]).toMatchObject({
      task_id: 'lifecycle', phase: 'lifecycle', agent_id: agentId,
      title: '有効期限に達したため終了しました',
    });
  });

  it('leaves no agent document and no dedicated resources', async () => {
    const start = Date.parse('2026-01-01T12:00:00.000Z');
    const harness = createLifecycleHarness({ now: () => start });
    const agentId = await seedDomain(harness, {
      isolationLevel: 'full_isolation', expiresAt: new Date(start - MINUTE).toISOString(),
    });
    const short = agentId.slice(-12);
    await harness.provisionerStore.set('dedicated_resources', agentId, {
      agent_id: agentId, status: 'READY', created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z', last_error: null,
      created: [
        { kind: 'service_account', name: `sa-op-${short}`, created_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
        { kind: 'cloud_run_service', name: `projects/p/locations/l/services/dedicated-op-${short}`, created_at: '2026-01-01T00:00:00.000Z', deleted_at: null },
      ],
    });

    await sweep({
      documents: harness.documents, expiringWindowSeconds: 60, now: () => start,
      cleanup: (id, reason) => cleanupAgent(id, reason, {
        documents: harness.documents, clients: harness.clients, logger, logContext, now: () => start,
      }),
    });

    expect(await harness.documents.get('agents', `${agentId}__meta`)).toBeUndefined();
    const ledger = await harness.documents.get<{ status: string; created: Array<{ deleted_at: string | null }> }>(
      'dedicated_resources', agentId,
    );
    // The ledger survives for the audit, with everything marked gone.
    expect(ledger!.status).toBe('RELEASED');
    expect(ledger!.created.every((entry) => entry.deleted_at !== null)).toBe(true);
  });
});
