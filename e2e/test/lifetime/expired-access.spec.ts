import { describe, expect, it } from 'vitest';
import { createSecurityHarness, logEntry, AGENT_ID } from '@xaa/security-detection/src/testing/harness';
import { normalizeEntries } from '@xaa/security-detection/src/normalize/index';
import { detectRuleHits } from '@xaa/security-detection/src/rules/index';

/** DEC-IAC-16's verification profile: one hour, injected, never a literal in the code. */
const MAX_LIFETIME_SECONDS = 3600;
const EXPIRED_AT = '2026-01-01T11:00:00.000Z';
const NOW = '2026-01-01T12:00:00.000Z';

/** What the Agent Runtime writes when it calls a tool after the agent's expiry. */
function accessAfterExpiry() {
  return logEntry({
    log_source: 'agent_runtime', app: 'agent-runtime', timestamp: NOW,
    fields: {
      tool_id: 'internal.document.list', expires_at: EXPIRED_AT,
      agent_age_seconds: 7200, outcome: 'denied',
    },
  });
}

/**
 * T-SEC-22 / REQ-09-033. An expired agent is refused, and the refusal is counted.
 *
 * Both halves matter and they are separate mechanisms. The Identity layer refuses the
 * request synchronously — that is what actually stops the access. The rule hit is the
 * record that it happened, and it is derived from the agent's own registration age
 * rather than from the container's uptime, so restarting a Cloud Run revision does not
 * reset an agent that has outlived its lifetime.
 */
describe('an expired agent', () => {
  it('expired agent is denied and rule hit is recorded', async () => {
    const events = normalizeEntries([accessAfterExpiry()]).events;
    expect(events[0]!.api.status).toBe('denied');

    const before = detectRuleHits({
      events: [], violations: [], baselines: new Map(), maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    });
    expect(before.hits).toHaveLength(0);

    const after = detectRuleHits({
      events, violations: [], baselines: new Map(), maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    });

    // One more row than before, and it names the expiry rather than a rate.
    expect(after.hits.length).toBe(before.hits.length + 2);
    const ruleIds = after.hits.map((hit) => hit.rule_id);
    expect(ruleIds).toContain('lifetime.access_after_expiry');
    expect(ruleIds).toContain('lifetime.age_exceeded');
    for (const hit of after.hits) {
      expect(hit.level).toBe('HIGH');
      expect(hit.agent_id).toBe(AGENT_ID);
    }
  });

  it('the finding the run stores carries the lifetime codes', async () => {
    const harness = createSecurityHarness({ maxLifetimeSeconds: MAX_LIFETIME_SECONDS });
    await harness.runOnce([accessAfterExpiry()]);

    const stored = await harness.documents.listAll<{ contributing_codes: string[] }>('security_findings');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data.contributing_codes).toEqual(
      expect.arrayContaining(['lifetime.access_after_expiry', 'lifetime.age_exceeded']),
    );
  });

  it('an agent inside its lifetime records nothing', async () => {
    const inside = logEntry({
      log_source: 'agent_runtime', app: 'agent-runtime', timestamp: NOW,
      fields: { tool_id: 'internal.document.list', expires_at: '2026-01-02T00:00:00.000Z', agent_age_seconds: 60 },
    });
    const result = detectRuleHits({
      events: normalizeEntries([inside]).events, violations: [], baselines: new Map(),
      maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    });
    expect(result.hits.filter((hit) => hit.rule_id.startsWith('lifetime.'))).toHaveLength(0);
  });
});
