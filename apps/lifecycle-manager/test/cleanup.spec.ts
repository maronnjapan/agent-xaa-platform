import { describe, expect, it } from 'vitest';
import { CLEANUP_STEPS } from '../src/cleanup/steps.js';
import { CLEANUP_STEP_IDS, type CleanupStepResult } from '../src/cleanup/result.js';
import { cleanupAgent } from '../src/cleanup/index.js';
import { CLEANUP_MAX_ATTEMPTS } from '../src/config.js';
import { createLifecycleHarness, recordingClients, seedDomain, type LifecycleHarness } from '../src/testing/harness.js';
import { createLogger } from '@xaa/logging';

const logger = createLogger('lifecycle-manager', 'provisioner', () => {});
const logContext = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null };

function deps(harness: LifecycleHarness, holder = 'test') {
  return { documents: harness.documents, clients: harness.clients, logger, logContext, holder };
}

/** Which recorded call each step makes, for the "one call per step" assertions. */
const CALL_FOR_STEP: Partial<Record<string, string>> = {
  runtime_cancel: 'cancelExecution',
  issuance_disable: 'disableIssuance',
  idp_connection_revoke: 'revokeIdpConnection',
  credential_revoke: 'revokeByActor',
  client_credential_revoke: 'revokeClientCredential',
  registration_delete: 'deleteRegistration',
};

describe('the cleanup orchestrator', () => {
  it('runs 11 steps in fixed order', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
    expect(outcome.status).toBe('DESTROYED');
    expect(outcome.results.map((entry) => entry.step)).toEqual([...CLEANUP_STEP_IDS]);
    expect(CLEANUP_STEPS.map((step) => step.id)).toEqual([...CLEANUP_STEP_IDS]);
    expect(CLEANUP_STEP_IDS).toHaveLength(11);
  });

  /**
   * Every one of the eleven, one at a time.
   *
   * The failure is injected into the step itself rather than into a client double,
   * because four of the steps make no outbound call at all and the property under test
   * belongs to the orchestrator, not to any particular dependency: whichever step
   * breaks, the other ten still run and the agent stays visibly REVOKED.
   */
  for (const stepId of CLEANUP_STEP_IDS) {
    it(`continues after a failing step and does not reach DESTROYED [${stepId}]`, async () => {
      const harness = createLifecycleHarness();
      const agentId = await seedDomain(harness);
      const step = CLEANUP_STEPS.find((entry) => entry.id === stepId)!;
      const original = step.run;
      step.run = async () => { throw new Error(`${stepId} failed`); };
      let outcome;
      try {
        outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
      } finally {
        step.run = original;
      }
      expect(outcome.status).toBe('REVOKED');
      const failed = outcome.results.filter((entry) => entry.status === 'failed').map((entry) => entry.step);
      // The audit step fails alongside it, and deliberately: it deletes the record the
      // retry will need, so it refuses to run while anything is outstanding.
      expect(failed.sort()).toEqual([...new Set(['audit_persist', stepId])].sort());
      // The other ten still ran: an agent must not keep a live credential because one
      // unrelated call was briefly unavailable.
      expect(outcome.results.map((entry) => entry.step)).toEqual([...CLEANUP_STEP_IDS]);
      expect(outcome.results.every((entry) => entry.attempts === 1)).toBe(true);
      const meta = await harness.documents.get<{ status: string }>('agents', `${agentId}__meta`);
      expect(meta!.status).toBe('REVOKED');
    });
  }

  it('keeps running the other steps when one client call throws', async () => {
    for (const [stepId, call] of Object.entries(CALL_FOR_STEP)) {
      const harness = createLifecycleHarness({ clients: recordingClients({ failAt: call }) });
      const agentId = await seedDomain(harness);
      const outcome = await cleanupAgent(agentId, 'EXPIRED', deps(harness));
      expect(outcome.status).toBe('REVOKED');
      expect(outcome.results.filter((entry) => entry.status === 'failed').map((entry) => entry.step).sort())
        .toEqual(['audit_persist', stepId].sort());
      expect(outcome.results).toHaveLength(11);
    }
  });

  it('reaches DESTROYED on the second call after the failure is fixed', async () => {
    const shared = (await import('@xaa/gcp')).createFirestoreDouble();
    const failing = createLifecycleHarness({ shared, clients: recordingClients({ failAt: 'disableIssuance' }) });
    const agentId = await seedDomain(failing);
    expect((await cleanupAgent(agentId, 'EXPIRED', deps(failing, 'first'))).status).toBe('REVOKED');

    const healthy = createLifecycleHarness({ shared });
    const second = await cleanupAgent(agentId, 'EXPIRED', deps(healthy, 'second'));
    expect(second.status).toBe('DESTROYED');
    // Only the step that failed ran again.
    expect(healthy.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(0);
    expect(healthy.clients.calls.filter((entry) => entry.target === 'disableIssuance')).toHaveLength(1);
  });

  it('is idempotent across three calls', async () => {
    const shared = (await import('@xaa/gcp')).createFirestoreDouble();
    const harness = createLifecycleHarness({ shared });
    const agentId = await seedDomain(harness);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(cleanupAgent(agentId, 'EXPIRED', deps(harness, `run-${attempt}`))).resolves.toBeTruthy();
    }
    for (const call of Object.values(CALL_FOR_STEP)) {
      const made = harness.clients.calls.filter((entry) => entry.target === call);
      // revokeByActor is two calls in one step, one per Resource AS.
      expect(made.length).toBe(call === 'revokeByActor' ? 2 : 1);
    }
  });

  it('stops retrying after CLEANUP_MAX_ATTEMPTS', async () => {
    const shared = (await import('@xaa/gcp')).createFirestoreDouble();
    const agentId = await seedDomain(createLifecycleHarness({ shared }));
    let calls = 0;
    for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS + 3; attempt += 1) {
      const harness = createLifecycleHarness({ shared, clients: recordingClients({ failAt: 'disableIssuance' }) });
      await cleanupAgent(agentId, 'EXPIRED', deps(harness, `run-${attempt}`));
      calls += harness.clients.calls.filter((entry) => entry.target === 'disableIssuance').length;
    }
    expect(calls).toBe(CLEANUP_MAX_ATTEMPTS);
  });

  it('holds a lock so a second run in flight does nothing', async () => {
    const harness = createLifecycleHarness({ now: () => Date.parse('2026-01-01T00:00:00.000Z') });
    const agentId = await seedDomain(harness);
    const [first, second] = await Promise.all([
      cleanupAgent(agentId, 'EXPIRED', { ...deps(harness, 'a'), now: () => Date.parse('2026-01-01T00:00:00.000Z') }),
      cleanupAgent(agentId, 'EXPIRED', { ...deps(harness, 'b'), now: () => Date.parse('2026-01-01T00:00:00.000Z') }),
    ]);
    const done = [first, second].filter((outcome) => outcome.results.length > 0);
    expect(done).toHaveLength(1);
    expect(harness.clients.calls.filter((entry) => entry.target === 'cancelExecution')).toHaveLength(1);
  });

  it('records the reason so a retry keeps it', async () => {
    const shared = (await import('@xaa/gcp')).createFirestoreDouble();
    const harness = createLifecycleHarness({ shared, clients: recordingClients({ failAt: 'disableIssuance' }) });
    const agentId = await seedDomain(harness);
    await cleanupAgent(agentId, 'QUARANTINE', deps(harness));
    const meta = await harness.documents.get<{ cleanup_reason: string; cleanup_step_results: CleanupStepResult[] }>(
      'agents', `${agentId}__meta`,
    );
    expect(meta!.cleanup_reason).toBe('QUARANTINE');
    expect(meta!.cleanup_step_results.find((entry) => entry.step === 'issuance_disable')!.status).toBe('failed');
  });
});
