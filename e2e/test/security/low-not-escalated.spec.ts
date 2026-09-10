import { describe, expect, it } from 'vitest';
import { createSecurityHarness, logEntry, AGENT_ID } from '@xaa/security-detection/src/testing/harness';
import { computeScore } from '@xaa/security-detection/src/score/compute';
import { toLevel } from '@xaa/security-detection/src/score/level';
import type { SecurityFinding } from '@xaa/security-detection/src/correlate/finding';

/** An hour is the agent's ceiling here, so an age of two hours is over it. */
const MAX_LIFETIME_SECONDS = 3600;

function runtimeEntry(fields: Record<string, unknown>) {
  return logEntry({
    log_source: 'agent_runtime', app: 'agent-runtime',
    timestamp: '2026-01-01T12:00:00.000Z', fields,
  });
}

/** One rule hit, worth twenty: the whole of a LOW finding. */
const AGED = { agent_age_seconds: 7200, expires_at: '2026-01-02T00:00:00.000Z' };
/** Two, worth forty: MEDIUM, and therefore a row. */
const AGED_AND_EXPIRED = { agent_age_seconds: 7200, expires_at: '2026-01-01T11:00:00.000Z' };

const finding = (codes: string[]): SecurityFinding => ({
  finding_id: 'f_probe', finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
  human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
  related_events: [], contributing_codes: codes, risk_score: null, risk_level: null,
  review_status: 'none', created_at: '2026-01-01T12:10:00.000Z',
});

/**
 * REQ-09-044. LOW is 「保存と観測」 — stored and watched, and escalated no further.
 *
 * The point is not that a low score is uninteresting — it is that escalation costs
 * something. A model call and a state change for every mildly unusual window would bury
 * the windows that matter, so the boundary at 30 is enforced where the decision is made
 * rather than in whatever reads the table afterwards.
 *
 * Not escalating is not the same as not recording, and this used to conflate the two:
 * the row was dropped as well, which meant a lone refused request (10) or a lone unknown
 * tool (25) left no trace at all and the Analysis Console had nothing to show for a
 * window the rules really had read (docs 09 §5.5, §7).
 */
describe('a LOW finding is not escalated', () => {
  it('score 20 is kept as the mechanical result and asks no model', async () => {
    // The score this batch produces, spelled out: one lifetime hit, worth twenty.
    expect(computeScore({ finding: finding(['lifetime.age_exceeded']) })).toBe(20);
    expect(toLevel(20)).toBe('LOW');

    const harness = createSecurityHarness({ maxLifetimeSeconds: MAX_LIFETIME_SECONDS });
    await harness.runOnce([runtimeEntry(AGED)]);

    const rows = await harness.documents.listAll<{ risk_level: string; analysis_source: string }>('security_findings');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.risk_level).toBe('LOW');
    // Marked as what it is: the passes ran, and nothing was asked of the model.
    expect(rows[0]!.data.analysis_source).toBe('rules');
    expect(harness.aiCalls).toBe(0);
    expect(harness.transitions).toHaveLength(0);
  });

  it('same window twice does not duplicate finding rows', async () => {
    expect(computeScore({ finding: finding(['lifetime.age_exceeded', 'lifetime.access_after_expiry']) })).toBe(40);

    const harness = createSecurityHarness({ maxLifetimeSeconds: MAX_LIFETIME_SECONDS });
    const batch = [runtimeEntry(AGED_AND_EXPIRED)];

    await harness.runOnce(batch);
    const first = await harness.documents.listAll('security_findings');
    expect(first).toHaveLength(1);

    // The same window, delivered again: the finding id is derived from the window and
    // the agent, so the second run overwrites its own earlier row rather than adding one.
    await harness.runOnce(batch);
    const second = await harness.documents.listAll('security_findings');
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });
});
