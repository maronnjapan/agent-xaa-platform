import { describe, expect, it } from 'vitest';
import { validateActivityEvent } from '@xaa/contracts';
import { capabilityDecidedMessage, isolationDecidedMessage } from '../src/activity/messages.js';
import { runDecision } from './helpers.js';

const BOTH = { capabilities: ['document.read', 'finance.payment.approve'] };

describe('the two decision events', () => {
  it('are what the subscriber accepts', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    for (const event of result.activity) expect(() => validateActivityEvent(event)).not.toThrow();
    expect(result.activity.map((event) => event.source)).toEqual(['authorization', 'authorization']);
    expect(result.activity.map((event) => event.task_id)).toEqual(['provisioning', 'provisioning']);
    expect(result.activity.map((event) => event.is_simulated)).toEqual([false, false]);
    expect(result.activity.map((event) => event.related_finding_id)).toEqual([null, null]);
  });

  it('name the rejected capability and why it was rejected', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    const capability = result.activity[0]!;
    const detail = capability.detail as { denied: Array<{ capability_id: string; violation_code: string }> };

    expect(detail.denied).toHaveLength(1);
    expect(detail.denied[0]).toEqual({
      capability_id: 'finance.payment.approve', violation_code: 'human_permission_exceeded',
    });
    expect(capability.message).toContain('finance.payment.approve');
    expect(capability.message).toContain('human_permission_exceeded');
  });

  it('carry the isolation level and the score as text', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    const isolation = result.activity[1]!;
    const profile = result.record.security_profile;
    expect(isolation.message).toContain(profile.isolation_level);
    expect(isolation.message).toContain(String(profile.risk_score));
    expect(isolation.detail).toMatchObject({
      isolation_level: profile.isolation_level, risk_score: profile.risk_score,
    });
  });

  it('are published even when nothing was rejected', async () => {
    const result = await runDecision({
      humanPermissions: ['document.read', 'finance.payment.approve'], model: BOTH,
    });
    const detail = result.activity[0]!.detail as { denied: unknown[] };
    expect(detail.denied).toEqual([]);
    expect(result.activity).toHaveLength(2);
  });

  it('do not fail the decision when the topic is unreachable', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH, failPublish: true });

    expect(result.record.status).toBe('decided');
    expect(await result.documents.get('authorization_decisions', result.record.decision_id)).toBeDefined();
    const warnings = result.logs
      .map((line) => JSON.parse(line) as { event: string; severity: string })
      .filter((line) => line.event === 'activity_publish_failed');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.severity).toBe('WARNING');
  });
});

describe('what the timeline says', () => {
  it('writes "許可なし" rather than an empty list', () => {
    expect(capabilityDecidedMessage([], [])).toBe('許可：許可なし');
  });

  it('leaves the rejection clause out when nothing was rejected', () => {
    expect(capabilityDecidedMessage(['document.read'], [])).toBe('許可：document.read');
  });

  it('states both halves when there is a rejection', () => {
    expect(capabilityDecidedMessage(['document.read'], [
      { capability_id: 'finance.payment.approve', violation_code: 'human_permission_exceeded' },
    ])).toBe('許可：document.read／却下：finance.payment.approve（理由：human_permission_exceeded）');
  });

  it('names the level and the score', () => {
    expect(isolationDecidedMessage('full_isolation', 40)).toBe('isolation_level=full_isolationに決定（risk_score 40）');
  });
});
