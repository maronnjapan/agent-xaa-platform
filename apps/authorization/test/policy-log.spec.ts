import { describe, expect, it } from 'vitest';
import { runDecision } from './helpers.js';

interface Line { event: string; fields: Record<string, unknown> }

function linesOf(logs: string[], event: string): Line[] {
  return logs.map((line) => JSON.parse(line) as Line).filter((line) => line.event === event);
}

const BOTH = { capabilities: ['document.read', 'finance.payment.approve'] };

describe('the Policy Engine log', () => {
  it('summarises the decision once', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    const summary = linesOf(result.logs, 'policy.decide');

    expect(summary).toHaveLength(1);
    expect(summary[0]!.fields).toMatchObject({
      decision_id: result.record.decision_id,
      proposed_capabilities: ['document.read', 'finance.payment.approve'],
      effective_capabilities: ['document.read'],
      isolation_level: result.record.security_profile.isolation_level,
      risk_score: result.record.security_profile.risk_score,
      reasons: result.record.security_profile.reasons,
    });
  });

  it('writes one line per evaluated capability', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    const perCapability = linesOf(result.logs, 'policy.capability_decision');
    expect(perCapability).toHaveLength(result.record.proposed_capabilities.length);
    expect(perCapability.map((line) => line.fields.capability_id).sort())
      .toEqual(['document.read', 'finance.payment.approve']);
  });

  it('derives the violation code on a refusal and leaves it null on an allow', async () => {
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH });
    const byCapability = new Map(linesOf(result.logs, 'policy.capability_decision')
      .map((line) => [String(line.fields.capability_id), line.fields]));

    expect(byCapability.get('finance.payment.approve')).toMatchObject({
      decision: 'DENY', reason_code: 'not_in_human_permission', violation_code: 'human_permission_exceeded',
    });
    const allowed = byCapability.get('document.read')!;
    expect(allowed).toMatchObject({ decision: 'ALLOW', reason_code: 'allowed' });
    expect(allowed).toHaveProperty('violation_code', null);
  });

  it('names capabilities and codes, never the work itself', async () => {
    const description = '取引先へ送る請求書の内容をまとめる';
    const result = await runDecision({ humanPermissions: ['document.read'], model: BOTH, description });
    const written = [...linesOf(result.logs, 'policy.decide'), ...linesOf(result.logs, 'policy.capability_decision')];
    expect(JSON.stringify(written)).not.toContain(description);
  });
});
