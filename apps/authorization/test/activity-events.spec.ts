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

/**
 * docs 11 §3.4 for a decision. One line — 許可：a／却下：b — told a person what came
 * out and nothing about how. The record says what the AI read, what it proposed and on
 * what grounds, what each of the five filters did with each proposal, and how the
 * profile was set.
 */
describe('what the decision record explains', () => {
  it('gives every proposed capability a verdict with its reason', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    const record = result.activity[0]!.record!;
    expect(record.headline).toBe('1 件の権限を許可し、1 件を却下しました');
    expect(record.checks).toEqual([
      { id: 'capability:document.read', label: 'document.read', result: 'passed', message: expect.stringContaining('許可しました') },
      { id: 'capability:finance.payment.approve', label: 'finance.payment.approve', result: 'blocked', message: expect.stringContaining('本人がこの権限を持っていない') },
    ]);
    expect((result.activity[0]!.detail as { proposed: string[] }).proposed).toEqual(BOTH.capabilities);
  });

  it('separates what the AI read, what it proposed, and what the engine decided', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: { ...BOTH, characteristics: { write_operation: true } } });
    const sections = result.activity[0]!.record!.sections;
    expect(sections.map((section) => section.id).slice(0, 3)).toEqual(['work_definition', 'proposal', 'policy']);
    const proposal = sections[1]!;
    expect(proposal.fields).toContainEqual({ label: '提案した Capability', value: 'document.read、finance.payment.approve' });
    expect(proposal.fields).toContainEqual({ label: 'AI が述べた性質', value: 'write_operation=true' });
    expect(proposal.message).toContain('決定ではありません');
    const policy = sections[2]!;
    expect(policy.fields).toContainEqual({ label: '本人が持っている権限', value: 'document.read' });
    expect(policy.fields).toContainEqual({ label: 'document.read', value: '許可' });
    expect(policy.fields?.find((field) => field.label === 'finance.payment.approve')?.value).toContain('却下');
  });

  it('carries the AI\'s own words as prose, marked as the AI\'s', async () => {
    const result = await runDecision({
      humanPermissions: ['document.read'],
      model: { raw: { capabilities: ['document.read'], characteristics: {}, confidence: 0.8, note: '書類を読むだけなので document.read で足ります。' } },
    });
    const proposal = result.activity[0]!.record!.sections.find((section) => section.id === 'proposal')!;
    expect(proposal.text).toBe('書類を読むだけなので document.read で足ります。');
    expect(proposal.format).toBe('text');
  });

  it('lists the conditions a policy attached and the profile\'s grounds', async () => {
    // A payment approval: risk-001 forces full isolation and caps the amount.
    const result = await runDecision({ humanPermissions: ['finance.payment.approve'], model: { capabilities: ['finance.payment.approve'] } });
    expect(result.record.effective_capabilities).toEqual(['finance.payment.approve']);
    const constraints = result.activity[0]!.record!.sections.find((section) => section.id === 'constraints')!;
    expect(constraints.fields?.[0]?.label).toBe('finance.payment.approve');
    expect(constraints.fields?.[0]?.value).toContain('max_amount');
    const profile = result.activity[1]!.record!;
    expect(profile.headline).toContain('full_isolation');
    expect(profile.sections[0]?.fields).toContainEqual({ label: '当てはまった理由', value: result.record.security_profile.reasons.join('、') });
    expect(result.record.security_profile.reasons).toContain('financial_operation');
    // The decision goes back to the Automation App: the one movement this service makes.
    expect(profile.hops).toEqual([expect.objectContaining({ from: 'authorization-platform', to: 'automation-app' })]);
  });

  it('says so when nothing could be granted, rather than saying nothing', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: { capabilities: ['slack.channel.admin'] } });
    expect(result.record.status).toBe('no_capability_inferred');
    expect(result.activity.map((event) => (event.detail as { event_type: string }).event_type)).toEqual(['CAPABILITY_DECIDED']);
    const record = result.activity[0]!.record!;
    expect(record.headline).toBe('許可できる権限はありませんでした');
    expect(record.checks).toEqual([
      { id: 'capability:slack.channel.admin', label: 'slack.channel.admin', result: 'blocked', message: expect.stringContaining('一覧に無い') },
    ]);
    for (const event of result.activity) expect(() => validateActivityEvent(event)).not.toThrow();
  });
});
