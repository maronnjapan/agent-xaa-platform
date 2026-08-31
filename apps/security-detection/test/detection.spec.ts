import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { LOG_SOURCES } from '@xaa/logging';
import { CLASS_UID, UNMAPPED_CLASS_UID, normalizeEntries } from '../src/normalize/index.js';
import { runPipeline, createPipelineDeps, PIPELINE_STAGES, dispatch, type DispatchCounters } from '../src/pipeline/index.js';
import { allRuleIds, detectRuleHits, THRESHOLDS } from '../src/rules/index.js';
import { groupByWindow, windowStart, WINDOW_MINUTES } from '../src/rules/window.js';
import { BASELINE_ELEMENTS } from '../src/baseline/types.js';
import { buildBaseline, BASE_RATE } from '../src/baseline/build.js';
import { detectDeviations, DEVIATION_KINDS } from '../src/baseline/deviation.js';
import { correlate } from '../src/correlate/index.js';
import { classify, findingId, type SecurityFinding } from '../src/correlate/finding.js';
import { SCORE_FACTORS, CRITICAL_SINGLETON_FACTORS, factorFor } from '../src/score/factors.js';
import { computeScore, SCORING } from '../src/score/compute.js';
import { ScoreOutOfRange, toLevel } from '../src/score/level.js';
import { canTransition, AGENT_SECURITY_STATES } from '../src/response/state.js';
import { needsHumanReview } from '../src/response/review.js';
import { fallbackResponse, parseAiOutput } from '../src/ai/output.js';
import { AiInputTooLarge, AI_INPUT_KEYS, buildAiInput, AI_INPUT_LIMIT_BYTES } from '../src/ai/input.js';
import { createInProcessBus, startPullLoop } from '../src/ingest/subscriber.js';
import { AGENT_ID, OTHER_AGENT_ID, baselineFor, logEntry } from '../src/testing/harness.js';

const converterDir = new URL('../src/normalize/converters', import.meta.url).pathname;

describe('normalization', () => {
  it('has one converter per log source', async () => {
    const files = (await readdir(converterDir)).filter((name) => name.endsWith('.ts'));
    expect(files).toHaveLength(10);
    expect(LOG_SOURCES).toHaveLength(10);
    expect(new Set(Object.values(CLASS_UID)).size).toBe(10);
  });

  it('converts every source and keeps the four common fields', () => {
    const entries = LOG_SOURCES.map((source) => logEntry({ log_source: source, app: source }));
    const result = normalizeEntries(entries);
    expect(result.events).toHaveLength(10);
    for (const event of result.events) {
      expect(event.actor.human_subject).toBe('testuser');
      expect(event.actor.agent_id).toBe(AGENT_ID);
      expect(event.metadata.trace_id).toBe('trace-1');
      expect(event.time).toBe('2026-01-01T12:00:00.000Z');
    }
  });

  it('tells a missing key apart from a null value', () => {
    const missing = { ...logEntry() } as Record<string, unknown>;
    delete missing.agent_id;
    expect(normalizeEntries([missing]).counters.schema_violation_total).toBe(1);
    // A human acting is an agent_id of null, and that is ordinary.
    const nulled = normalizeEntries([logEntry({ agent_id: null })]);
    expect(nulled.events).toHaveLength(1);
    expect(nulled.counters.schema_violation_total).toBe(0);
  });

  it('keeps an unmapped source under its own class and passes it no further', () => {
    const result = normalizeEntries([logEntry({ log_source: 'automation_app' as never })]);
    expect(result.events).toHaveLength(0);
    expect(result.unmapped).toHaveLength(1);
    expect(result.unmapped[0]!.class_uid).toBe(UNMAPPED_CLASS_UID);
    expect(result.counters.unmapped_source_total).toBe(1);
  });

  it('falls back to request_id when there is no trace, and rejects neither', () => {
    expect(normalizeEntries([logEntry({ trace_id: '' })]).events[0]!.metadata.correlation_uid).toBe('req-1');
    expect(normalizeEntries([logEntry({ trace_id: '', request_id: '' })]).counters.schema_violation_total).toBe(1);
  });
});

describe('the pipeline', () => {
  it('calls six stages in the declared order', () => {
    const called: string[] = [];
    const stub = <T>(name: string, value: T) => (): T => { called.push(name); return value; };
    runPipeline([], {
      collect: stub('collect', { __stage: 'raw', entries: [] }),
      normalize: stub('normalize', { __stage: 'normalized', events: [], unmapped: [] }),
      validateProtocol: stub('validateProtocol', { __stage: 'validated', events: [], violations: [] }),
      detectRules: stub('detectRules', { __stage: 'rule_hits', events: [], violations: [], hits: [] }),
      correlate: stub('correlate', { __stage: 'correlated', findings: [] }),
      score: stub('score', { __stage: 'scored', findings: [] }),
    });
    expect(called).toEqual([...PIPELINE_STAGES]);
  });

  it('reads a protocol violation out of the log rather than re-deciding it', () => {
    const counters: DispatchCounters = { low_events_total: 0, unmapped_code_total: 0 };
    const deps = createPipelineDeps({ baselines: new Map(), counters });
    const validated = deps.validateProtocol(deps.normalize(deps.collect([
      logEntry({ severity: 'WARNING', fields: { validation: 'human_subject_mismatch' } }),
    ])));
    expect(validated.violations).toHaveLength(1);
    expect(validated.violations[0]!.code).toBe('human_subject_mismatch');
  });
});

describe('the ten minute window', () => {
  it('uses fixed boundaries, not a sliding one', () => {
    expect(WINDOW_MINUTES).toBe(10);
    // Two events three minutes apart across a boundary land in different windows.
    expect(windowStart('2026-01-01T12:09:59.000Z')).not.toBe(windowStart('2026-01-01T12:10:01.000Z'));
    expect(windowStart('2026-01-01T12:00:00.000Z')).toBe(windowStart('2026-01-01T12:09:59.000Z'));
  });

  it('groups by window and key together', () => {
    const groups = groupByWindow(
      [{ id: 'a', at: '2026-01-01T12:00:00.000Z' }, { id: 'a', at: '2026-01-01T12:20:00.000Z' }],
      (item) => item.id, (item) => item.at,
    );
    expect(groups.size).toBe(2);
  });
});

describe('rule detection', () => {
  const baselines = new Map([[AGENT_ID, baselineFor()]]);

  function events(count: number) {
    return Array.from({ length: count }, (_unused, index) => normalizeEntries([logEntry({
      timestamp: `2026-01-01T12:0${index % 10}:00.000Z`, fields: { result: 'issued' },
    })]).events[0]!);
  }

  it('fires above the ceiling and stays quiet at it', () => {
    // Two tools, so the id_jag ceiling is the base 20.
    const max = baselineFor().expected_rate.id_jag.max;
    expect(max).toBe(BASE_RATE.id_jag.max);
    const medium = THRESHOLDS.token!.medium_multiplier;

    const atLimit = detectRuleHits({ events: events(max * medium), violations: [], baselines });
    expect(atLimit.hits.filter((hit) => hit.rule_id.startsWith('token.token_request'))).toHaveLength(0);

    const over = detectRuleHits({ events: events(max * medium + 1), violations: [], baselines });
    expect(over.hits.some((hit) => hit.rule_id === 'token.token_request.medium')).toBe(true);
  });

  it('emits no hit and counts the gap when a baseline is missing', () => {
    const result = detectRuleHits({ events: events(500), violations: [], baselines: new Map() });
    expect(result.hits).toHaveLength(0);
    expect(result.counters.baseline_missing_total).toBe(1);
  });

  it('lists five token metrics and maps every rule id to a factor', () => {
    expect(THRESHOLDS.token!.metrics).toHaveLength(5);
    for (const ruleId of allRuleIds()) expect(factorFor(ruleId)).not.toBeNull();
  });
});

describe('the agent baseline', () => {
  it('has all six elements', () => {
    const baseline = baselineFor();
    expect(Object.keys(baseline).sort()).toEqual([...BASELINE_ELEMENTS].sort());
  });

  it('scales the expected rate with the tool count', () => {
    const four = buildBaseline({
      effectiveCapabilities: [], expectedTools: ['a', 'b', 'c', 'd'], expectedResources: [],
      expiresAt: '2026-01-02T00:00:00.000Z',
    });
    expect(four.expected_rate.api_request.max).toBe(200);
    expect(four.expected_rate.id_jag.max).toBe(40);
  });

  it('copies the expiry rather than recomputing it', () => {
    expect(baselineFor({ expiresAt: '2026-03-03T03:03:03.000Z' }).lifetime).toBe('2026-03-03T03:03:03.000Z');
  });

  it('starts every counter at zero', () => {
    expect(Object.values(baselineFor().current_session_behavior).every((value) => value === 0)).toBe(true);
  });
});

describe('baseline deviation', () => {
  const baseline = baselineFor();

  it('names six kinds and finds each of them', () => {
    expect(DEVIATION_KINDS).toHaveLength(6);

    const unexpectedTool = detectDeviations({
      baseline,
      events: normalizeEntries([logEntry({
        log_source: 'agent_runtime', fields: { tool_id: 'internal.finance.payment.approve' },
      })]).events,
    });
    expect(unexpectedTool.some((deviation) => deviation.kind === 'unexpected_tool')).toBe(true);

    // Known tool, capability the agent does not hold: the tool id alone would miss it.
    const mismatch = detectDeviations({
      baseline,
      events: normalizeEntries([logEntry({ log_source: 'agent_runtime', fields: { tool_id: 'internal.document.list' } })]).events,
      toolCapabilities: { 'internal.document.list': 'document.write' },
    });
    expect(mismatch.some((deviation) => deviation.kind === 'capability_mismatch')).toBe(true);

    const foreign = detectDeviations({
      baseline,
      events: normalizeEntries([logEntry({ fields: { op_agent_id: OTHER_AGENT_ID } })]).events,
    });
    expect(foreign.some((deviation) => deviation.kind === 'foreign_dedicated_op_access')).toBe(true);

    const afterExpiry = detectDeviations({
      baseline,
      events: normalizeEntries([logEntry({ timestamp: '2026-06-01T00:00:00.000Z' })]).events,
    });
    expect(afterExpiry.some((deviation) => deviation.kind === 'access_after_expiry')).toBe(true);
  });

  it('compares the rate against the ceiling itself, with no multiplier', () => {
    const many = Array.from({ length: 21 }, () => normalizeEntries([logEntry()]).events[0]!);
    const deviations = detectDeviations({ baseline, events: many });
    const rate = deviations.find((deviation) => deviation.kind === 'rate_exceeded');
    expect(rate).toBeTruthy();
    expect(rate!.expected).toBe(baseline.expected_rate.id_jag.max);
  });

  it('lets one event yield two deviations', () => {
    const deviations = detectDeviations({
      baseline,
      events: normalizeEntries([logEntry({
        log_source: 'agent_runtime',
        fields: { tool_id: 'internal.finance.payment.approve', resource: 'https://resource-finance-api.test' },
      })]).events,
    });
    expect(deviations.filter((deviation) => deviation.kind === 'unexpected_tool')).toHaveLength(1);
    expect(deviations.filter((deviation) => deviation.kind === 'unexpected_resource')).toHaveLength(1);
  });
});

describe('correlation', () => {
  const hit = (overrides: Partial<Parameters<typeof correlate>[0]['hits'][number]> = {}) => ({
    rule_id: 'isolation.cross_agent_access.high', category: 'isolation' as const, level: 'HIGH' as const,
    agent_id: AGENT_ID, human_subject: 'testuser', occurred_at: '2026-01-01T12:00:00.000Z',
    trace_id: 'trace-1', related_events: ['trace-1'], detail: {}, ...overrides,
  });

  it('gives the same finding id for the same window and subject', () => {
    const first = correlate({ hits: [hit()], violations: [], now: () => 1 });
    const second = correlate({ hits: [hit()], violations: [], now: () => 999_999 });
    expect(first[0]!.finding_id).toBe(second[0]!.finding_id);
    expect(findingId(0, AGENT_ID)).toMatch(/^f_0_[0-9a-f]{8}$/);
  });

  it('makes no finding for an empty window', () => {
    expect(correlate({ hits: [], violations: [] })).toEqual([]);
  });

  it('calls three families of code a compromise, and fewer an anomaly', () => {
    expect(classify([
      'authorization.unknown_audience.high', 'isolation.cross_agent_access.high', 'token.id_jag_issued.high',
    ])).toBe('potential_agent_compromise');
    expect(classify(['authorization.unknown_audience.high'])).toBe('anomalous_agent_activity');
  });

  it('reports one cross-agent finding instead of two per-agent ones', () => {
    const findings = correlate({
      hits: [hit(), hit({ agent_id: OTHER_AGENT_ID, trace_id: 'trace-2', related_events: ['trace-2'] })],
      violations: [],
    });
    expect(findings.filter((finding) => finding.finding_type === 'cross_agent_lateral_movement')).toHaveLength(1);
    // The hits were consumed, so neither agent gets its own finding for them.
    expect(findings).toHaveLength(1);
  });

  it('leaves a single isolation hit with its own agent', () => {
    const findings = correlate({ hits: [hit()], violations: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.agent_id).toBe(AGENT_ID);
  });

  it('reports one dedicated OP touched by two people as a platform breach', () => {
    const findings = correlate({
      hits: [
        hit({ detail: { dedicated_short_id: 'abcdefghijkl' } }),
        hit({ agent_id: OTHER_AGENT_ID, human_subject: 'someone-else', detail: { dedicated_short_id: 'abcdefghijkl' } }),
      ],
      violations: [],
    });
    expect(findings.some((finding) => finding.finding_type === 'platform_wide_isolation_breach')).toBe(true);
  });

  it('sorts related events by time', () => {
    const findings = correlate({
      hits: [
        hit({ occurred_at: '2026-01-01T12:05:00.000Z', trace_id: 'later', related_events: ['later'] }),
        hit({ occurred_at: '2026-01-01T12:01:00.000Z', trace_id: 'earlier', related_events: ['earlier'] }),
      ],
      violations: [],
    });
    expect(findings[0]!.related_events).toEqual(['earlier', 'later']);
  });
});

describe('risk scoring', () => {
  const finding = (codes: string[]): SecurityFinding => ({
    finding_id: 'f_1_abc', finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: codes, risk_score: null, risk_level: null,
    review_status: 'none', created_at: '2026-01-01T12:10:00.000Z',
  });

  it('has thirteen factors, matching the config exactly', () => {
    expect(SCORE_FACTORS).toHaveLength(13);
    expect(Object.keys(SCORING).sort()).toEqual([...SCORE_FACTORS].sort());
  });

  it('clamps to 100 and is deterministic', () => {
    const codes = Array.from({ length: 40 }, (_unused, index) => `authorization.unknown_audience.${index}`);
    expect(computeScore({ finding: finding(codes) })).toBeLessThanOrEqual(100);
    expect(computeScore({ finding: finding(['tool.unauthorized_tool.high']) }))
      .toBe(computeScore({ finding: finding(['tool.unauthorized_tool.high']) }));
  });

  it('adds a premium for the finance resource only', () => {
    const docs = computeScore({
      finding: finding(['tool.unauthorized_tool.high']),
      financeResourceUrl: 'https://resource-finance-api.test',
      resources: ['https://resource-docs-api.test'],
    });
    const finance = computeScore({
      finding: finding(['tool.unauthorized_tool.high']),
      financeResourceUrl: 'https://resource-finance-api.test',
      resources: ['https://resource-finance-api.test'],
    });
    expect(finance).toBeGreaterThan(docs);
  });

  it('counts a code it cannot map rather than ignoring it', () => {
    const counters = { unmapped_code_total: 0 };
    computeScore({ finding: finding(['something.nobody.defined']), counters });
    expect(counters.unmapped_code_total).toBe(1);
  });

  it('makes each singleton factor critical on its own', () => {
    expect(CRITICAL_SINGLETON_FACTORS).toHaveLength(2);
    expect(computeScore({ finding: finding(['human_subject_mismatch']) })).toBe(100);
    expect(computeScore({ finding: finding(['invalid_signature']) })).toBe(100);
    // And still critical however the weights are edited: the invariant is in the code.
    expect(computeScore({ finding: finding(['delegation_mismatch', 'behavior_deviation']) })).toBe(100);
  });
});

describe('risk levels', () => {
  it('maps the eight boundary points', () => {
    expect([0, 29, 30, 59, 60, 79, 80, 100].map(toLevel))
      .toEqual(['LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'CRITICAL', 'CRITICAL']);
  });

  it('throws rather than clamping out-of-range input', () => {
    expect(() => toLevel(-1)).toThrow(ScoreOutOfRange);
    expect(() => toLevel(101)).toThrow(ScoreOutOfRange);
  });
});

describe('dispatch', () => {
  const finding = (level: 'LOW' | 'HIGH'): SecurityFinding => ({
    finding_id: `f_${level}`, finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: [], risk_score: level === 'LOW' ? 20 : 70,
    risk_level: level, review_status: 'none', created_at: '2026-01-01T12:10:00.000Z',
  });

  it('stores a LOW finding and calls no model', async () => {
    const counters: DispatchCounters = { low_events_total: 0, unmapped_code_total: 0 };
    let analyzed = 0;
    let stored = 0;
    let normalized = 0;
    await dispatch({ __stage: 'scored', findings: [finding('LOW')] }, {
      analyze: async () => { analyzed += 1; },
      storeFinding: async () => { stored += 1; },
      storeNormalized: async () => { normalized += 1; },
    }, counters);
    expect(analyzed).toBe(0);
    expect(stored).toBe(0);
    expect(normalized).toBe(1);
    expect(counters.low_events_total).toBe(1);
  });

  it('writes a finding and calls the model from MEDIUM up', async () => {
    const counters: DispatchCounters = { low_events_total: 0, unmapped_code_total: 0 };
    let analyzed = 0;
    let stored = 0;
    await dispatch({ __stage: 'scored', findings: [finding('HIGH')] }, {
      analyze: async () => { analyzed += 1; },
      storeFinding: async () => { stored += 1; },
      storeNormalized: async () => undefined,
    }, counters);
    expect(analyzed).toBe(1);
    expect(stored).toBe(1);
    expect(counters.low_events_total).toBe(0);
  });
});

describe('the AI boundary', () => {
  const finding: SecurityFinding = {
    finding_id: 'f_1', finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
    related_events: [], contributing_codes: [], risk_score: 70, risk_level: 'HIGH',
    review_status: 'none', created_at: '2026-01-01T12:10:00.000Z',
  };

  it('fills all sixteen items', () => {
    const input = buildAiInput({
      finding, baseline: baselineFor(), registration: { isolation_level: 'standard' },
      relatedEvents: [], workDefinitionHash: 'h', operationKinds: ['document.read'], agentAgeSeconds: 60,
    });
    expect(Object.keys(input).sort()).toEqual([...AI_INPUT_KEYS].sort());
  });

  it('never carries the text of the work definition', () => {
    const input = buildAiInput({
      finding, baseline: baselineFor(), registration: {},
      relatedEvents: [], workDefinitionHash: 'abc', operationKinds: ['document.read'], agentAgeSeconds: 0,
    });
    expect(Object.keys(input.work_definition_summary).sort()).toEqual(['hash', 'operation_kinds']);
    expect(JSON.stringify(input)).not.toContain('毎朝の日報');
  });

  it('drops the oldest events to fit, keeping the newest', () => {
    const related = Array.from({ length: 1000 }, (_unused, index) => ({
      occurred_at: `2026-01-01T12:00:${String(index % 60).padStart(2, '0')}.000Z`,
      code: `code-${index}`, tool_id: 'internal.document.list',
      resource: 'https://resource-docs-api.test', status: 'ok',
    }));
    const input = buildAiInput({
      finding, baseline: baselineFor(), registration: {},
      relatedEvents: related, workDefinitionHash: 'h', operationKinds: [], agentAgeSeconds: 0,
    });
    expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(AI_INPUT_LIMIT_BYTES);
    expect(input.related_events_summary.at(-1)!.code).toBe('code-999');
  });

  it('throws when it still does not fit with nothing left to drop', () => {
    const huge = 'x'.repeat(AI_INPUT_LIMIT_BYTES * 2);
    expect(() => buildAiInput({
      finding, baseline: baselineFor(), registration: { note: huge },
      relatedEvents: [], workDefinitionHash: 'h', operationKinds: [], agentAgeSeconds: 0,
    })).toThrow(AiInputTooLarge);
  });

  it('returns null for anything it cannot use, and never throws', () => {
    expect(parseAiOutput('not json')).toBeNull();
    expect(parseAiOutput(JSON.stringify({ deviation: {}, judgement: {}, impact: {} }))).toBeNull();
    expect(parseAiOutput(JSON.stringify({
      deviation: { from_normal: 'a', capability_consistency: 'b' },
      judgement: { compromise_likelihood: 'a', false_positive_likelihood: 'b', causality: 'c' },
      impact: { scope: 'a', op_propagation: 'b' },
      recommendation: { response: 'QUARANTINED', confidence: 1.4 },
    }))).toBeNull();
  });

  it('accepts a well-formed four-aspect answer', () => {
    const output = parseAiOutput(JSON.stringify({
      deviation: { from_normal: 'a', capability_consistency: 'b' },
      judgement: { compromise_likelihood: 'a', false_positive_likelihood: 'b', causality: 'c' },
      impact: { scope: 'a', op_propagation: 'b' },
      recommendation: { response: 'SUSPICIOUS', confidence: 0.9 },
    }));
    expect(output!.recommendation.response).toBe('SUSPICIOUS');
  });

  it('falls back by risk level', () => {
    expect(fallbackResponse('CRITICAL')).toBe('QUARANTINED');
    expect(fallbackResponse('HIGH')).toBe('SUSPICIOUS');
    expect(fallbackResponse('MEDIUM')).toBe('ACTIVE');
  });

  it('names no model in the source', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      new URL('../src/ai/vertex-client.ts', import.meta.url), 'utf8',
    );
    expect(source).not.toContain('gemini');
  });
});

describe('response', () => {
  it('only ever moves forward', () => {
    let allowed = 0;
    for (const from of AGENT_SECURITY_STATES) {
      for (const to of AGENT_SECURITY_STATES) if (canTransition(from, to)) allowed += 1;
    }
    // Ten of the twenty-five pairs move forward; the rest, including staying put, do not.
    expect(allowed).toBe(10);
    expect(canTransition('QUARANTINED', 'ACTIVE')).toBe(false);
    expect(canTransition('ACTIVE', 'ACTIVE')).toBe(false);
  });

  it('holds a low-confidence or high-impact recommendation for a person', () => {
    expect(needsHumanReview({ response: 'ACTIVE', confidence: 0.5, fromFallback: false })).toBe(true);
    expect(needsHumanReview({ response: 'QUARANTINED', confidence: 0.99, fromFallback: false })).toBe(true);
    expect(needsHumanReview({ response: 'ACTIVE', confidence: 0.99, fromFallback: true })).toBe(true);
    expect(needsHumanReview({ response: 'SUSPICIOUS', confidence: 0.9, fromFallback: false })).toBe(false);
  });
});

describe('ingest', () => {
  it('acks after the handler and nacks when it throws', async () => {
    const acked: string[] = [];
    const makeMessage = (body: unknown) => ({
      data: Buffer.from(JSON.stringify(body)),
      ack: () => acked.push('ack'), nack: () => acked.push('nack'),
    });
    let listener: ((message: ReturnType<typeof makeMessage>) => void) | undefined;
    startPullLoop({ on: (_event, handler) => { listener = handler as never; } }, async (payload) => {
      if ((payload as { fail?: boolean }).fail) throw new Error('handler failed');
    });
    listener!(makeMessage({ fail: false }));
    listener!(makeMessage({ fail: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acked).toEqual(['ack', 'nack']);
  });

  it('delivers in process for the tests', async () => {
    const bus = createInProcessBus();
    const seen: unknown[] = [];
    bus.subscribe(async (payload) => { seen.push(payload); });
    await bus.publish({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
  });
});
