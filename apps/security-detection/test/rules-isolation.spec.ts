import { describe, expect, it } from 'vitest';
import { shortId } from '@xaa/contracts';
import { detectIsolationHits } from '../src/rules/isolation.js';
import type { AgentRegistrationView, RuleContext } from '../src/rules/context.js';
import { correlate } from '../src/correlate/index.js';
import { normalizeEntries } from '../src/normalize/index.js';
import { AGENT_ID, OTHER_AGENT_ID, baselineFor, logEntry } from '../src/testing/harness.js';

const REGISTRATION: AgentRegistrationView = { idp_connection_id: 'idpconn-own' };

function context(
  entries: readonly Parameters<typeof logEntry>[0][],
  registrations: ReadonlyMap<string, AgentRegistrationView> = new Map([[AGENT_ID, REGISTRATION]]),
): RuleContext {
  return {
    events: normalizeEntries(entries.map((overrides) => logEntry(overrides))).events,
    violations: [],
    baselines: new Map([[AGENT_ID, baselineFor()]]),
    registrations,
    maxLifetimeSeconds: null,
  };
}

/** One issuance ledger line, as `emitIssuanceLedger` writes it. */
function issuance(sub: string, actSub: string, traceId: string) {
  return {
    event: 'idjag_issuance', trace_id: traceId, human_subject: sub,
    fields: { jti: traceId, sub, act_sub: actSub, typ: 'oauth-id-jag+jwt' },
  };
}

/**
 * REQ-09-034. The three isolation conditions, each decided from the log line itself.
 */
describe('the isolation classification', () => {
  it('cross agent idp access hits high', () => {
    const hits = detectIsolationHits(context([{ fields: { idp_connection_id: 'idpconn-someone-else' } }]));
    expect(hits.map((hit) => hit.rule_id)).toEqual(['isolation.cross_agent_idp']);
    expect(hits[0]!.level).toBe('HIGH');
    expect(hits[0]!.detail).toEqual({ observed: 'idpconn-someone-else', expected: 'idpconn-own' });
    // The agent's own connection is not a finding.
    expect(detectIsolationHits(context([{ fields: { idp_connection_id: 'idpconn-own' } }]))).toHaveLength(0);
  });

  it('dedicated op mismatch hits high', () => {
    // A line written for agent-b that names agent-a's dedicated OP.
    const hits = detectIsolationHits(context([{ agent_id: OTHER_AGENT_ID, fields: { op_agent_id: AGENT_ID } }], new Map()));
    expect(hits.map((hit) => hit.rule_id)).toEqual(['isolation.dedicated_op_mismatch']);
    expect(hits[0]!.level).toBe('HIGH');
    expect(hits[0]!.detail).toMatchObject({ observed: AGENT_ID, expected: OTHER_AGENT_ID });
    // The short id is what the platform-wide correlation groups on.
    expect(hits[0]!.detail.dedicated_short_id).toBe(shortId(AGENT_ID));
    expect(detectIsolationHits(context([{ fields: { op_agent_id: AGENT_ID } }]))).toHaveLength(0);
  });

  it('reaches the platform-wide breach through the short id it puts in detail', () => {
    const hits = detectIsolationHits(context([
      { agent_id: OTHER_AGENT_ID, human_subject: 'user-a', fields: { op_agent_id: AGENT_ID } },
      { agent_id: 'agent-cccccccccccccccccccccccccc', human_subject: 'user-b', trace_id: 'trace-2', fields: { op_agent_id: AGENT_ID } },
    ], new Map()));
    const findings = correlate({ hits, violations: [] });
    expect(findings.some((finding) => finding.finding_type === 'platform_wide_isolation_breach')).toBe(true);
  });

  it('same act sub with two subjects hits high once', () => {
    const hits = detectIsolationHits(context([
      issuance('user-A', 'urn:agent:one', 'trace-1'),
      issuance('user-B', 'urn:agent:one', 'trace-2'),
    ], new Map()));
    const matched = hits.filter((hit) => hit.rule_id === 'isolation.multi_subject_actor');
    expect(matched).toHaveLength(1);
    expect(matched[0]!.level).toBe('HIGH');
    expect(matched[0]!.detail.observed).toEqual(['user-A', 'user-B']);
    expect(matched[0]!.related_events.sort()).toEqual(['trace-1', 'trace-2']);
  });

  it('leaves one actor serving one person alone', () => {
    const hits = detectIsolationHits(context([
      issuance('user-A', 'urn:agent:one', 'trace-1'),
      issuance('user-A', 'urn:agent:one', 'trace-2'),
    ], new Map()));
    expect(hits).toHaveLength(0);
  });

  it('reads the token exchange spelling of the same three facts', () => {
    const hits = detectIsolationHits(context([
      { trace_id: 't1', fields: { issued_jti: 'j1', actor_token_sub: 'urn:agent:one', subject_token_sub: 'user-A' } },
      { trace_id: 't2', fields: { issued_jti: 'j2', actor_token_sub: 'urn:agent:one', subject_token_sub: 'user-B' } },
    ], new Map()));
    expect(hits.filter((hit) => hit.rule_id === 'isolation.multi_subject_actor')).toHaveLength(1);
  });
});
