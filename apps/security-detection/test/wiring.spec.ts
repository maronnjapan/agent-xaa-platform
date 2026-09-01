import { describe, expect, it } from 'vitest';
import { TOOL_IDS } from '@xaa/contracts';
import { createPipelineDeps, runPipeline, resourcesOf, type DispatchCounters } from '../src/pipeline/index.js';
import { detectRuleHits } from '../src/rules/index.js';
import { normalizeEntries } from '../src/normalize/index.js';
import { emitQuarantineEvent, QuarantineEventRejected } from '../src/activity/quarantine-event.js';
import type { SecurityFinding } from '../src/correlate/finding.js';
import {
  AGENT_ID, CALLER_TOKEN, DOCUMENT_TOOLS, FINANCE_RESOURCE, OTHER_AGENT_ID,
  baselineFor, createSecurityHarness, logEntry,
} from '../src/testing/harness.js';

const DOCS_RESOURCE = 'https://resource-docs-api.test';

function counters(): DispatchCounters {
  return { low_events_total: 0, unmapped_code_total: 0 };
}

/**
 * What the audit could not see from inside a single module: whether the classifications,
 * the deviation pass and the Activity Event are reachable from the run the pull loop and
 * the push route actually call.
 *
 * Each case here starts at `runOnce` or at `runPipeline` with production wiring, never at
 * the function under test. A unit test that calls `detectIsolationHits` directly passes
 * whether or not anything ever calls it, which is exactly how five classifications came
 * to be written and never run.
 */
describe('the classifications are reachable from the production pipeline', () => {
  const baselines = new Map([[AGENT_ID, baselineFor()]]);
  const registrations = new Map([[AGENT_ID, { idp_connection_id: 'idpconn-own', allowed_audiences: ['https://docs-as.test'], resources: [DOCS_RESOURCE] }]]);

  function run(entries: readonly unknown[], maxLifetimeSeconds: number | null = 3600) {
    return runPipeline(entries, createPipelineDeps({
      baselines, registrations, counters: counters(), maxLifetimeSeconds,
      financeResourceUrl: FINANCE_RESOURCE, now: () => Date.parse('2026-01-01T12:10:00.000Z'),
    }));
  }

  const codesOf = (entries: readonly unknown[], max: number | null = 3600) =>
    run(entries, max).findings.flatMap((finding) => finding.contributing_codes);

  it('produces an isolation code from a dedicated OP mismatch', () => {
    expect(codesOf([logEntry({ fields: { op_agent_id: OTHER_AGENT_ID } })]))
      .toContain('isolation.dedicated_op_mismatch');
  });

  it('produces a lifetime code from an expired access', () => {
    expect(codesOf([logEntry({
      log_source: 'agent_runtime', app: 'agent-runtime',
      fields: { expires_at: '2026-01-01T11:00:00.000Z', agent_age_seconds: 7200 },
    })])).toEqual(expect.arrayContaining(['lifetime.access_after_expiry', 'lifetime.age_exceeded']));
  });

  it('produces a tool code from a call outside the manifest', () => {
    const other = TOOL_IDS.find((tool) => !DOCUMENT_TOOLS.includes(tool as never))!;
    expect(codesOf([logEntry({ log_source: 'agent_runtime', app: 'agent-runtime', fields: { tool_id: other } })]))
      .toContain('tool.not_provisioned');
  });

  it('produces an authorization code from a scope the capabilities cannot reach', () => {
    expect(codesOf([logEntry({ fields: { requested_scope: 'finance.tx.write' } })]))
      .toContain('authorization.scope_out_of_range');
  });

  it('produces an authorization AI code from a capability outside the taxonomy', () => {
    expect(codesOf([logEntry({ log_source: 'authz_ai', app: 'authorization', fields: { proposed_capabilities: ['document.purge'], effective_capabilities: ['document.purge'] } })]))
      .toContain('authz_ai.unknown_capability');
  });

  it('carries the baseline deviations onto the finding', () => {
    const scored = run([logEntry({
      log_source: 'resource_api', app: 'resource-finance-api',
      fields: { response_status: '200', resource: FINANCE_RESOURCE, tool_id: 'internal.finance.payment.approve' },
    })]);
    const finding = scored.findings[0]!;
    expect(finding.deviations?.map((deviation) => deviation.kind).sort())
      .toEqual(['capability_mismatch', 'unexpected_resource', 'unexpected_tool']);
  });

  it('scores the finance premium, which needs the resources of the finding', () => {
    const finance = run([logEntry({
      log_source: 'resource_api', app: 'resource-finance-api',
      fields: { response_status: '200', resource: FINANCE_RESOURCE, tool_id: 'internal.finance.payment.approve' },
    })]).findings[0]!;
    const docs = run([logEntry({
      log_source: 'resource_api', app: 'resource-docs-api',
      fields: { response_status: '200', resource: 'https://elsewhere.test', tool_id: 'internal.finance.payment.approve' },
    })]).findings[0]!;
    expect(finance.risk_score!).toBeGreaterThan(docs.risk_score!);
  });

  it('names the resources of the events a finding was actually built from', () => {
    const events = normalizeEntries([logEntry({
      log_source: 'resource_api', app: 'resource-docs-api', fields: { resource: DOCS_RESOURCE },
    })]).events;
    const finding = { related_events: ['trace-1'] } as SecurityFinding;
    expect(resourcesOf(finding, events)).toEqual([DOCS_RESOURCE]);
    expect(resourcesOf({ related_events: ['other'] } as SecurityFinding, events)).toEqual([]);
  });

  it('still classifies isolation for an agent that has no baseline', () => {
    // Only the token rules need a baseline; an unprovisioned baseline must not silence
    // the boundary checks, which was the effect of gating every rule on one.
    const result = detectRuleHits({
      events: normalizeEntries([logEntry({ fields: { op_agent_id: OTHER_AGENT_ID } })]).events,
      violations: [], baselines: new Map(), registrations: new Map(), maxLifetimeSeconds: null,
    });
    expect(result.counters.baseline_missing_total).toBe(1);
    expect(result.hits.map((hit) => hit.rule_id)).toEqual(['isolation.dedicated_op_mismatch']);
  });
});

describe('the quarantine Activity Event', () => {
  const critical = {
    finding_id: 'f_1_abcdef01', finding_type: 'potential_agent_compromise' as const, agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: ['isolation.dedicated_op_mismatch'], risk_score: 90,
    risk_level: 'CRITICAL' as const, review_status: 'pending' as const, created_at: '2026-01-01T12:10:00.000Z',
    recommended_response: 'QUARANTINED' as const, confidence: 0.5,
  };

  async function approve(harness: ReturnType<typeof createSecurityHarness>, token = CALLER_TOKEN) {
    await harness.documents.set('security_findings', critical.finding_id, critical as unknown as Record<string, unknown>);
    return harness.fetch(`/internal/review/${critical.finding_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: 'approve', reviewer: 'operator@example.test' }),
    });
  }

  it('critical finding emits one quarantine event once the transition is sent', async () => {
    const harness = createSecurityHarness();
    expect((await approve(harness)).status).toBe(200);
    expect(harness.transitions).toHaveLength(1);
    expect(harness.activity).toHaveLength(1);
    const event = harness.activity[0]!;
    expect(event.detail).toMatchObject({ event_type: 'AGENT_QUARANTINED' });
    expect(event.phase).toBe('security');
    expect(event.outcome).toBe('blocked');
    expect(event.task_id).toBe('lifecycle');
    expect(event.message).toBe(`異常検知により Agent を隔離しました（Finding: ${critical.finding_id}）`);
  });

  it('related_finding_id is not null', async () => {
    const harness = createSecurityHarness();
    await approve(harness);
    expect(harness.activity[0]!.related_finding_id).toBe(critical.finding_id);
    await expect(emitQuarantineEvent({
      payload: { ...payload(), related_finding_id: '' }, traceId: 't', publish: async () => undefined,
    })).rejects.toThrow(QuarantineEventRejected);
  });

  it('payload contains no jwt like string', async () => {
    const harness = createSecurityHarness();
    await approve(harness);
    expect(JSON.stringify(harness.activity[0])).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    await expect(emitQuarantineEvent({
      payload: { ...payload(), contributing_codes: ['eyJhbGciOiJSUzI1NiJ9.body.sig'] },
      traceId: 't', publish: async () => undefined,
    })).rejects.toThrow(QuarantineEventRejected);
  });

  it('no event when the transition request is refused', async () => {
    const harness = createSecurityHarness();
    // A finding with no agent id: `requestTransition` refuses, so nothing was quarantined.
    await harness.documents.set('security_findings', 'f_no_agent', {
      ...critical, finding_id: 'f_no_agent', agent_id: null,
    } as unknown as Record<string, unknown>);
    const response = await harness.fetch('/internal/review/f_no_agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CALLER_TOKEN}` },
      body: JSON.stringify({ decision: 'approve', reviewer: 'operator@example.test' }),
    });
    expect(response.status).toBe(200);
    expect(harness.transitions).toHaveLength(0);
    expect(harness.activity).toHaveLength(0);
  });

  it('publishes nothing for a rejection or for a lesser response', async () => {
    const rejected = createSecurityHarness();
    await rejected.documents.set('security_findings', critical.finding_id, critical as unknown as Record<string, unknown>);
    await rejected.fetch(`/internal/review/${critical.finding_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CALLER_TOKEN}` },
      body: JSON.stringify({ decision: 'reject', reviewer: 'operator@example.test' }),
    });
    expect(rejected.activity).toHaveLength(0);

    const suspicious = createSecurityHarness();
    await suspicious.documents.set('security_findings', 'f_susp', {
      ...critical, finding_id: 'f_susp', recommended_response: 'SUSPICIOUS',
    } as unknown as Record<string, unknown>);
    await suspicious.fetch('/internal/review/f_susp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CALLER_TOKEN}` },
      body: JSON.stringify({ decision: 'approve', reviewer: 'operator@example.test' }),
    });
    expect(suspicious.transitions).toHaveLength(1);
    expect(suspicious.activity).toHaveLength(0);
  });

  function payload() {
    return {
      agent_id: AGENT_ID, human_subject: 'testuser', related_finding_id: 'f_1',
      risk_level: 'CRITICAL' as const, contributing_codes: [] as string[],
    };
  }
});

describe('the human review route', () => {
  it('refuses a caller it cannot verify, and one that is not allowed', async () => {
    const open = createSecurityHarness({ reviewerVerify: undefined });
    const refused = await open.fetch('/internal/review/f_1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reviewer: 'a' }),
    });
    // No Authorization header at all: an approval is a state change, not a public route.
    expect(refused.status).toBe(403);

    const wrong = await open.fetch('/internal/review/f_1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad' },
      body: JSON.stringify({ decision: 'approve', reviewer: 'a' }),
    });
    expect(wrong.status).toBe(403);
  });

  it('stays closed when no reviewer check is configured', async () => {
    const closed = createSecurityHarness({ reviewerVerify: async () => null });
    const response = await closed.fetch('/internal/review/f_1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CALLER_TOKEN}` },
      body: JSON.stringify({ decision: 'approve', reviewer: 'a' }),
    });
    expect(response.status).toBe(403);
  });
});
