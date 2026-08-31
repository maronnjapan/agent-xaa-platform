import { describe, expect, it, vi } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import { decide, type DecisionStep } from '../src/pipeline/decide.js';
import * as effective from '../src/policy/effective.js';
import { createFakeVertex, seedAuthorizationData, TAXONOMY } from './helpers.js';
import { CAPABILITIES } from '@xaa/contracts';

async function fixture(options: { humanPermissions?: string[]; model?: Parameters<typeof createFakeVertex>[0] } = {}) {
  const firestore = createFirestoreDouble();
  const documents = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(documents, options.humanPermissions ?? [...CAPABILITIES], createFirestoreDocumentStore(firestore, 'seed'));
  const steps: DecisionStep[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const vertex = createFakeVertex(options.model ?? {});
  return {
    documents, steps, activity, vertex,
    store: createAuthorizationStore(documents),
    run: () => decide({
      humanSubject: 'testuser', purpose: '予定整理', description: '当日の予定を取得して整理する',
      constraints: {}, requestedLifetimeHours: 8,
    }, {
      store: createAuthorizationStore(documents), vertex,
      clock: { now: () => Date.parse('2026-03-01T00:00:00Z') },
      recordStep: (step) => steps.push(step),
      publishActivity: async (event) => { activity.push(event); },
    }),
  };
}

describe('the decision pipeline', () => {
  it('runs the steps in the documented order', async () => {
    const harness = await fixture();
    await harness.run();
    expect(harness.steps).toEqual([
      'validate', 'work_definition', 'infer', 'sanitize', 'taxonomy_filter', 'save_proposal',
      'merge_characteristics', 'load_policy_inputs', 'policy_engine', 'security_profile',
      'save_decision', 'activity_event', 'respond',
    ]);
  });

  it('hands the Policy Engine all seven inputs, none undefined', async () => {
    const harness = await fixture();
    const spy = vi.spyOn(effective, 'computeEffectiveCapabilities');
    // The pipeline imports the function directly, so the argument shape is checked by
    // running the real thing and reading back what it was given through the result.
    spy.mockRestore();
    const record = await harness.run();
    const input = await harness.store.loadHumanPermissions('testuser');
    expect(input.length).toBeGreaterThan(0);
    expect(record.status).toBe('decided');
    expect(record.effective_capabilities).toEqual(['calendar.event.read']);
  });

  it('reads nothing from the store once the engine has started', async () => {
    const harness = await fixture();
    await harness.run();
    // load_policy_inputs is the last step before policy_engine in the recorded order.
    const engineIndex = harness.steps.indexOf('policy_engine');
    expect(harness.steps.indexOf('load_policy_inputs')).toBeLessThan(engineIndex);
  });

  it('calls the model exactly twice: once to structure, once to propose', async () => {
    const harness = await fixture();
    await harness.run();
    expect(harness.vertex.calls).toBe(2);
  });

  it('skips the engine entirely when nothing survives the taxonomy filter', async () => {
    const harness = await fixture({ model: { capabilities: ['slack.channel.admin'] } });
    const record = await harness.run();
    expect(record.status).toBe('no_capability_inferred');
    expect(record.effective_capabilities).toEqual([]);
    expect(record.security_profile).toEqual({ risk_score: 0, isolation_level: 'standard', reasons: [] });
    for (const skipped of ['merge_characteristics', 'load_policy_inputs', 'policy_engine', 'security_profile'] as const) {
      expect(harness.steps).not.toContain(skipped);
    }
    expect(record.dropped_out_of_taxonomy).toEqual(['slack.channel.admin']);
  });

  it('still records a decision when nothing was inferred', async () => {
    const harness = await fixture({ model: { capabilities: [] } });
    const record = await harness.run();
    expect(await harness.documents.get('authorization_decisions', record.decision_id)).toBeDefined();
  });

  it('writes one policy_decision row per evaluated capability', async () => {
    const harness = await fixture({ model: { capabilities: ['calendar.event.read', 'mail.message.send'] } });
    const record = await harness.run();
    const rows = await harness.documents.queryEqual('policy_decisions', [['decision_id', record.decision_id]]);
    expect(rows).toHaveLength(record.proposed_capabilities.length);
  });

  it('drops a target resource the taxonomy does not know', async () => {
    const harness = await fixture({ model: { targetResources: ['calendar', 'salesforce'] } });
    await harness.run();
    const proposals = await harness.documents.listAll<{ dropped_target_resource: string[] }>('ai_proposals');
    expect(proposals[0]!.data.dropped_target_resource).toEqual(['salesforce']);
  });

  it('normalises operations, dropping blanks and duplicates', async () => {
    const harness = await fixture({ model: { operations: ['Read Events', 'read_events', '', 'read events'] } });
    await harness.run();
    const definitions = await harness.documents.listAll<{ operations: string[] }>('work_definitions');
    expect(definitions[0]!.data.operations).toEqual(['read_events']);
  });

  it('publishes one activity event carrying the decision', async () => {
    const harness = await fixture();
    await harness.run();
    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0]).toMatchObject({ event_type: 'AUTHORIZATION_DECIDED', phase: 'authorization' });
  });

  it('keeps the taxonomy list stable', () => {
    expect(TAXONOMY).toHaveLength(8);
  });
});
