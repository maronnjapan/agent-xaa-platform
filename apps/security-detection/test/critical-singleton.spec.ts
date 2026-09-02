import { afterEach, describe, expect, it } from 'vitest';
import { CRITICAL_SINGLETON_FACTORS, SCORE_FACTORS, factorFor } from '../src/score/factors.js';
import { SCORING, computeScore } from '../src/score/compute.js';
import { toLevel } from '../src/score/level.js';
import type { SecurityFinding } from '../src/correlate/finding.js';
import { AGENT_ID } from '../src/testing/harness.js';

function finding(codes: string[]): SecurityFinding {
  return {
    finding_id: 'f_1_abc', finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: codes, risk_score: null, risk_level: null,
    review_status: 'none', created_at: '2026-01-01T12:10:00.000Z',
  };
}

/**
 * T-SEC-31 / REQ-09-043. Two findings that are CRITICAL with nothing beside them.
 *
 * A mismatched delegation means an agent reached a resource on behalf of somebody who
 * never delegated to it; a misused signing key means a token was signed by something
 * that is not the OP. Neither is a matter of degree, so neither is summed with anything
 * — and the invariant lives in the code rather than in the weights, so that lowering a
 * number in scoring.json cannot quietly make a forgery survivable.
 */
describe('the single-event criticals', () => {
  const original = { ...SCORING.delegation_mismatch };
  afterEach(() => { SCORING.delegation_mismatch = { ...original }; });

  it('delegation mismatch alone is 100 critical', () => {
    // Both spellings reach the same factor: the Agent OP's own refusal code, and the
    // rule id the saved SQL view produces (T-SEC-09).
    for (const code of ['human_subject_mismatch', 'delegation_mismatch', 'isolation.human_subject_mismatch.medium']) {
      expect(factorFor(code)).toBe('delegation_mismatch');
      const score = computeScore({ finding: finding([code]) });
      expect(score).toBe(100);
      expect(toLevel(score)).toBe('CRITICAL');
    }
  });

  it('signing key misuse alone is 100 critical', () => {
    for (const code of ['signing_key_misuse', 'invalid_signature']) {
      expect(factorFor(code)).toBe('signing_key_misuse');
      const score = computeScore({ finding: finding([code]) });
      expect(score).toBe(100);
      expect(toLevel(score)).toBe('CRITICAL');
    }
  });

  it('stays critical when scoring json lowers the value', () => {
    SCORING.delegation_mismatch = { per_event: 1, cap: 1 };
    expect(computeScore({ finding: finding(['delegation_mismatch']) })).toBe(100);
    // And still critical when it arrives among ordinary evidence rather than alone.
    expect(computeScore({ finding: finding(['delegation_mismatch', 'token.token_request.medium']) })).toBe(100);
  });

  it('critical singleton list has exactly two factors', () => {
    expect(CRITICAL_SINGLETON_FACTORS).toHaveLength(2);
    expect([...CRITICAL_SINGLETON_FACTORS]).toEqual(['delegation_mismatch', 'signing_key_misuse']);
    for (const factor of CRITICAL_SINGLETON_FACTORS) expect(SCORE_FACTORS).toContain(factor);
  });
});
