import { describe, expect, it } from 'vitest';
import { correlate } from '../src/correlate/index.js';
import { correlateCrossAgent } from '../src/correlate/cross-agent.js';
import { hitId, type RuleHit } from '../src/rules/types.js';
import { AGENT_ID, OTHER_AGENT_ID } from '../src/testing/harness.js';

const THIRD_AGENT_ID = 'agent-cccccccccccccccccccccccccc';

function hit(overrides: Partial<RuleHit> = {}): RuleHit {
  return {
    rule_id: 'isolation.dedicated_op_mismatch', category: 'isolation', level: 'HIGH',
    agent_id: AGENT_ID, human_subject: 'testuser', occurred_at: '2026-01-01T12:00:00.000Z',
    trace_id: 'trace-1', related_events: ['trace-1'], detail: {}, ...overrides,
  };
}

/** Agent A reaching another agent's dedicated OP, as the isolation rule records it. */
function foreignAccess(target: string, trace: string): RuleHit {
  return hit({ trace_id: trace, related_events: [trace], detail: { observed: target, expected: AGENT_ID } });
}

/**
 * T-SEC-28 / REQ-09-037. The views wider than one agent.
 *
 * docs 09 §5.3: "Agent A から Agent B、C、D の OP への横方向アクセスは、Agent 単体の
 * ログでは見えず、中央でまとめて初めて検出できる". Every one of those lines carries
 * `agent_id = A`, so the correlation has to count the agents a hit is *about*, not only
 * the one that produced it — otherwise three lateral movements read as three unrelated
 * anomalies belonging to one busy agent.
 */
describe('correlation across agents', () => {
  it('two foreign dedicated op accesses become one cross agent finding', () => {
    const findings = correlate({
      hits: [foreignAccess(OTHER_AGENT_ID, 'trace-b'), foreignAccess(THIRD_AGENT_ID, 'trace-c')],
      violations: [],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]!.finding_type).toBe('cross_agent_lateral_movement');
    expect(findings[0]!.human_subject).toBe('testuser');
    // Named by the person, not by an agent: the movement belongs to none of them alone.
    expect(findings[0]!.agent_id).toBeNull();
    expect(findings[0]!.related_events).toEqual(['trace-b', 'trace-c']);
  });

  it('consumed hits do not appear in per agent findings', () => {
    const hits = [foreignAccess(OTHER_AGENT_ID, 'trace-b'), foreignAccess(THIRD_AGENT_ID, 'trace-c')];
    const cross = correlateCrossAgent({ hits, createdAt: '2026-01-01T12:10:00.000Z' });

    expect(cross.consumed.sort()).toEqual(hits.map(hitId).sort());
    const findings = correlate({ hits, violations: [] });
    // Counting the same evidence twice would inflate both findings and make one
    // incident look like several.
    expect(findings.filter((finding) => finding.agent_id === AGENT_ID)).toHaveLength(0);
    expect(findings).toHaveLength(1);
  });

  it('single isolation hit stays in per agent finding', () => {
    const findings = correlate({ hits: [foreignAccess(OTHER_AGENT_ID, 'trace-b')], violations: [] });

    expect(findings).toHaveLength(1);
    expect(findings[0]!.agent_id).toBe(AGENT_ID);
    expect(findings[0]!.finding_type).not.toBe('cross_agent_lateral_movement');
  });

  it('correlation runs in fixed order', () => {
    // Two people reaching the same dedicated OP: the platform-wide pass claims it.
    const shared = { dedicated_short_id: 'abcdefghijkl' };
    const findings = correlate({
      hits: [
        hit({ detail: { ...shared, observed: OTHER_AGENT_ID } }),
        hit({
          agent_id: OTHER_AGENT_ID, human_subject: 'someone-else', trace_id: 'trace-2',
          related_events: ['trace-2'], detail: { ...shared, observed: AGENT_ID },
        }),
      ],
      violations: [],
    });
    expect(findings.some((finding) => finding.finding_type === 'platform_wide_isolation_breach')).toBe(true);
    // bySubject and global both ran before byAgent, so no per-agent finding survives.
    expect(findings.every((finding) => finding.agent_id === null)).toBe(true);
  });
});
