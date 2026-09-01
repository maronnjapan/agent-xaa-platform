import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@xaa/contracts';
import { classifyChange, retainedCapabilities } from '../src/reevaluate/classify.js';
import { reevaluate } from '../src/reevaluate/reevaluate.js';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import type { ReprovisionRequest } from '../src/reevaluate/reprovision-client.js';
import { createAuthzHarness, seedAgent, seedDecision, seedHumanPermissions, type AuthzHarness } from './helpers.js';

const SUBJECT = 'user-456';
const CHANGE = { human_subject: SUBJECT, changed_at: '2026-03-02T09:00:00.000Z' };

/**
 * One agent, one decision behind it, and whatever the person holds now. The branch is
 * decided by the difference between the two, so each case only has to state both.
 */
async function scenario(input: { proposed: string[]; oldEffective: string[]; nowHolds: string[] }) {
  const harness = await createAuthzHarness({ humanPermissions: [] });
  await seedHumanPermissions(harness, SUBJECT, input.nowHolds);
  await seedDecision(harness, {
    decisionId: 'dec_seed-1', humanSubject: SUBJECT,
    proposed: input.proposed, effective: input.oldEffective, createdAt: '2026-03-01T00:00:00.000Z',
  });
  await seedAgent(harness, {
    agentId: 'agent-1', humanSubject: SUBJECT, status: 'ACTIVE', createdAt: '2026-03-01T01:00:00.000Z',
  });

  const reprovisions: ReprovisionRequest[] = [];
  const activity: ActivityEvent[] = [];
  const outcomes = await reevaluate(CHANGE, {
    store: createAuthorizationStore(harness.documents),
    clock: { now: () => Date.parse('2026-03-02T09:00:01.000Z') },
    requestReprovision: async (request) => { reprovisions.push(request); },
    publish: async (event) => { activity.push(event); },
  });
  return { harness, outcomes, reprovisions, activity };
}

function eventTypes(activity: ActivityEvent[]): string[] {
  return activity.map((event) => String((event.detail as { event_type?: unknown }).event_type));
}

describe('classifyChange', () => {
  it('reads the four relations off the sets alone', () => {
    expect(classifyChange(['a', 'b'], ['b', 'a'])).toBe('unchanged');
    expect(classifyChange(['a', 'b'], ['a'])).toBe('shrunk');
    expect(classifyChange(['a'], ['a', 'b'])).toBe('expanded');
    expect(classifyChange(['a', 'b'], ['a', 'c'])).toBe('mixed');
  });

  it('ignores order and duplicates', () => {
    expect(classifyChange(['b', 'a', 'a'], ['a', 'b'])).toBe('unchanged');
    expect(classifyChange([], [])).toBe('unchanged');
  });

  it('keeps only what the agent already had', () => {
    expect(retainedCapabilities(['a', 'b'], ['b', 'c'])).toEqual(['b']);
  });
});

describe('what each branch does', () => {
  it('unchanged: nothing is asked of anyone', async () => {
    const result = await scenario({
      proposed: ['document.read'], oldEffective: ['document.read'], nowHolds: ['document.read'],
    });
    expect(result.outcomes.map((outcome) => outcome.change)).toEqual(['unchanged']);
    expect(result.reprovisions).toHaveLength(0);
    expect(result.activity).toHaveLength(0);
  });

  it('shrunk: Lifecycle is asked to rebuild the agent with less', async () => {
    const result = await scenario({
      proposed: ['document.read', 'finance.payment.approve'],
      oldEffective: ['document.read', 'finance.payment.approve'],
      nowHolds: ['document.read'],
    });
    expect(result.outcomes.map((outcome) => outcome.change)).toEqual(['shrunk']);
    expect(result.reprovisions).toEqual([{
      agentId: 'agent-1',
      effectiveCapabilities: ['document.read'],
      workDefinitionId: 'wd_dec_seed-1',
      reason: 'human_permission_revoked',
    }]);
    expect(eventTypes(result.activity)).toEqual([]);
  });

  it('expanded: the running agent is left alone and the timeline says so', async () => {
    const result = await scenario({
      proposed: ['document.read', 'calendar.event.read'],
      oldEffective: ['document.read'],
      nowHolds: ['document.read', 'calendar.event.read'],
    });
    expect(result.outcomes.map((outcome) => outcome.change)).toEqual(['expanded']);
    expect(result.reprovisions).toHaveLength(0);
    expect(eventTypes(result.activity)).toEqual(['PERMISSION_CHANGE_IGNORED']);
    expect(result.activity[0]!.agent_id).toBe('agent-1');
    expect((result.activity[0]!.detail as { added_capabilities: string[] }).added_capabilities)
      .toEqual(['calendar.event.read']);
  });

  it('mixed: it is treated as a narrowing, and the widening is dropped on the way', async () => {
    const result = await scenario({
      proposed: ['document.read', 'finance.payment.approve', 'calendar.event.read'],
      oldEffective: ['document.read', 'finance.payment.approve'],
      nowHolds: ['document.read', 'calendar.event.read'],
    });
    expect(result.outcomes.map((outcome) => outcome.change)).toEqual(['mixed']);
    expect(result.reprovisions).toHaveLength(1);
    // The newly granted calendar capability must not arrive by way of a re-provisioning.
    expect(result.reprovisions[0]!.effectiveCapabilities).toEqual(['document.read']);
    expect(eventTypes(result.activity)).toEqual([]);
  });

  it('records the new decision without touching the old one', async () => {
    const result = await scenario({
      proposed: ['document.read', 'finance.payment.approve'],
      oldEffective: ['document.read', 'finance.payment.approve'],
      nowHolds: ['document.read'],
    });
    const decisionId = result.outcomes[0]!.decision_id;
    expect(decisionId).not.toBe('dec_seed-1');
    const stored = await result.harness.documents.get<{ effective_capabilities: string[]; previous_decision_id: string }>(
      'authorization_decisions', decisionId,
    );
    expect(stored?.effective_capabilities).toEqual(['document.read']);
    expect(stored?.previous_decision_id).toBe('dec_seed-1');
    const rows = await result.harness.documents.queryEqual('policy_decisions', [['decision_id', decisionId]]);
    expect(rows).toHaveLength(2);
  });

  it('has no way to edit a running agent', async () => {
    // The absence is the point: RULE-14 holds because no such function exists.
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('../src/reevaluate/reevaluate.ts', import.meta.url), 'utf8'));
    expect(source).not.toMatch(/updateEffectiveCapabilities|patchAgentCapabilities/);
  });
});

describe('agents that cannot be re-evaluated', () => {
  it('is skipped and logged when no decision precedes the agent', async () => {
    const harness: AuthzHarness = await createAuthzHarness({ humanPermissions: [] });
    await seedHumanPermissions(harness, SUBJECT, ['document.read']);
    await seedAgent(harness, {
      agentId: 'agent-1', humanSubject: SUBJECT, status: 'ACTIVE', createdAt: '2026-03-01T01:00:00.000Z',
    });
    const outcomes = await reevaluate(CHANGE, {
      store: createAuthorizationStore(harness.documents),
      clock: { now: () => Date.parse('2026-03-02T09:00:01.000Z') },
    });
    expect(outcomes).toEqual([]);
  });
});
