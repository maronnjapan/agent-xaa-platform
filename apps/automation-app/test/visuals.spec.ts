/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ActivityRecord, AnalysisDecision, AnalysisRun } from '@xaa/contracts';
import { GATE_IDS, STAGE_NODES, traceDecision } from '../src/ui/analysis/trace.js';
import { checkCounts, routeStops, stepVerdict } from '../src/ui/records/verdict.js';
import { DecisionFlow, FLOW_EDGES, FLOW_NODES } from '../src/ui/components/decision-flow.js';
import { DecisionTraceList } from '../src/ui/components/decision-trace.js';
import { ExecutionLog } from '../src/ui/components/execution-log.js';
import { EventDetail } from '../src/ui/components/event-detail.js';
import { EventLog } from '../src/ui/components/event-log.js';
import { OutcomeBar } from '../src/ui/components/outcome-bar.js';
import { RouteStrip } from '../src/ui/components/route-strip.js';
import { CountFunnel, StageTiming } from '../src/ui/components/stage-timing.js';
import { TaskRow } from '../src/ui/components/task-row.js';
import { TaskShape } from '../src/ui/components/task-shape.js';
import { TrialTracker, trialStepStates } from '../src/ui/components/trial-tracker.js';
import { SecurityPage, STAGE_LABELS, TRACE_ACTION } from '../src/ui/pages/security.js';
import { html as render, mount } from './render.js';

/**
 * The pictures beside the words: each one is drawn from values a publisher recorded,
 * and each of these checks that the value on the picture is the value in the record.
 */

function decision(overrides: Partial<AnalysisDecision>): AnalysisDecision {
  return {
    finding_id: 'f-1', agent_id: 'agent-a', codes: ['invalid_scope'], score: 45, level: 'MEDIUM',
    state: 'skipped', reason: 'below_ai_threshold', response: null, confidence: null, transition: null,
    ...overrides,
  };
}

describe('the route a finding took', () => {
  it('stops at the first question for a score under the threshold', () => {
    const trace = traceDecision(decision({ score: 12, level: 'LOW', reason: 'below_ai_threshold' }));
    expect(trace.gates.map((gate) => gate.answer)).toEqual(['no', 'unreached', 'unreached', 'unreached', 'unreached', 'unreached', 'unreached']);
    expect(trace.gates[0]!.evidence).toBe('12 / 100 · LOW');
    expect(trace.end).toMatchObject({ id: 'skip', tone: 'skip' });
    expect(trace.path).toEqual([...STAGE_NODES, 'threshold', 'skip']);
    expect(trace.current).toBeNull();
  });

  it('goes through the model and out to a continued agent', () => {
    const trace = traceDecision(decision({ state: 'responded', reason: 'keep_active', response: 'ACTIVE', confidence: 0.9, transition: 'refused' }));
    expect(trace.gates.map((gate) => gate.answer)).toEqual(['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'yes']);
    expect(trace.gates.find((gate) => gate.id === 'confidence')!.evidence).toBe('90%');
    expect(trace.path).toContain('analyze');
    expect(trace.path.at(-1)).toBe('continue');
  });

  it('waits at the model while the model is being asked', () => {
    const trace = traceDecision(decision({ state: 'analyzing', reason: 'score_requires_ai' }));
    expect(trace.gates.map((gate) => gate.answer).slice(0, 4)).toEqual(['yes', 'yes', 'yes', 'pending']);
    expect(trace.end).toMatchObject({ id: 'analyze', tone: 'pending' });
    expect(trace.current).toBe('analyze');
    expect(trace.path.at(-1)).toBe('analyze');
  });

  it('holds a disruptive recommendation for a person', () => {
    const trace = traceDecision(decision({ state: 'review', reason: 'disruptive_response', response: 'QUARANTINED', confidence: 0.95 }));
    expect(trace.gates.find((gate) => gate.id === 'disruptive')).toMatchObject({ answer: 'yes', evidence: 'QUARANTINED' });
    expect(trace.gates.find((gate) => gate.id === 'keep')!.answer).toBe('unreached');
    expect(trace.end).toMatchObject({ id: 'review', tone: 'review' });
  });

  it('says a request is still on its way, and when it failed', () => {
    expect(traceDecision(decision({ state: 'responding', reason: 'automatic_response', response: 'SUSPICIOUS', confidence: 0.8 })).end)
      .toMatchObject({ id: 'respond', tone: 'pending' });
    expect(traceDecision(decision({ state: 'responded', reason: 'automatic_response', response: 'SUSPICIOUS', confidence: 0.8, transition: 'sent' })).end)
      .toMatchObject({ id: 'respond', tone: 'respond' });
    expect(traceDecision(decision({ state: 'failed', reason: 'transition_failed', response: 'SUSPICIOUS', confidence: 0.8, transition: 'failed' })).end)
      .toMatchObject({ id: 'failed', tone: 'failed' });
    expect(traceDecision(decision({ state: 'failed', reason: 'analysis_run_failed' })).end).toMatchObject({ tone: 'failed' });
  });

  it('asks the seven questions in the order the detector does', () => {
    expect(GATE_IDS).toEqual(['threshold', 'baseline', 'ai_configured', 'answered', 'confidence', 'disruptive', 'keep']);
    const listed = render(createElement(DecisionTraceList, { trace: traceDecision(decision({ reason: 'baseline_missing' })) }));
    expect([...listed.matchAll(/data-gate="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['threshold', 'baseline', 'ai_configured', 'analyze', 'answered', 'confidence', 'disruptive', 'keep']);
    expect(listed).toContain('data-gate="baseline" data-answer="no"');
    expect(listed).toContain('data-end="skip"');
  });
});

describe('the flowchart of the decision', () => {
  it('has a node for every stage, every question and every end, and an edge between them', () => {
    const ids = FLOW_NODES.map((node) => node.id);
    for (const id of [...STAGE_NODES, ...GATE_IDS, 'analyze', 'skip', 'review', 'continue', 'respond']) expect(ids).toContain(id);
    for (const edge of FLOW_EDGES) {
      expect(ids).toContain(edge.from);
      expect(ids).toContain(edge.to);
    }
    // Every question has both answers drawn.
    for (const gate of GATE_IDS) {
      expect(FLOW_EDGES.filter((edge) => edge.from === gate).map((edge) => edge.answer).sort()).toEqual(['no', 'yes']);
    }
  });

  it('lights only the path a traced finding took', () => {
    const idle = render(createElement(DecisionFlow, { trace: null }));
    expect(idle).toContain('data-traced="false"');
    expect(idle).not.toContain('data-taken="true"');

    const lit = render(createElement(DecisionFlow, {
      trace: traceDecision(decision({ state: 'responded', reason: 'keep_active', response: 'ACTIVE', confidence: 0.9 })), findingId: 'f-1',
    }));
    expect(lit).toContain('data-traced="true"');
    expect(lit).toContain('data-traced-finding="f-1"');
    expect(lit).toMatch(/data-flow-node="continue"[^>]*data-taken="true"/);
    expect(lit).toMatch(/data-flow-node="respond"[^>]*data-taken="false"/);
    expect(lit).toMatch(/data-flow-node="skip"[^>]*data-taken="false"/);
    expect(lit).toMatch(/data-flow-edge="keep-continue" data-taken="true"/);
    expect(lit).toMatch(/data-flow-edge="keep-respond" data-taken="false"/);
    expect(lit).toMatch(/data-flow-edge="threshold-skip" data-taken="false"/);
  });

  it('marks where an unfinished finding is waiting', () => {
    const waiting = render(createElement(DecisionFlow, { trace: traceDecision(decision({ state: 'analyzing', reason: 'score_requires_ai' })) }));
    expect(waiting).toMatch(/data-flow-node="analyze"[^>]*data-current="true"/);
  });

  it('is lit from the card that asked, on the page', async () => {
    const run: AnalysisRun = {
      run_id: 'r-1', human_subject: 'testuser', started_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:04Z',
      status: 'completed', stage: 'respond', completed_stages: ['collect', 'normalize', 'validateProtocol', 'detectRules', 'correlate', 'score', 'analyze', 'respond'],
      stage_durations_ms: { collect: 1000, analyze: 3000 },
      input_count: 4, normalized_count: 4, unmapped_count: 0, violation_count: 1, rule_hit_count: 1, error_code: null,
      decisions: [decision({ state: 'review', reason: 'low_confidence', response: 'QUARANTINED', confidence: 0.5 })],
    };
    const view = await mount(createElement(SecurityPage, { runs: [run], now: Date.parse('2026-09-09T00:00:10Z') }));
    expect(view.find('[data-decision-flow]')!.getAttribute('data-traced')).toBe('false');
    expect(view.text('[data-action="trace-decision"]')).toBe(TRACE_ACTION);
    await view.click('[data-action="trace-decision"][data-finding-id="f-1"]');
    expect(view.find('[data-decision-flow]')!.getAttribute('data-traced')).toBe('true');
    expect(view.find('[data-flow-node="review"]')!.getAttribute('data-taken')).toBe('true');
    expect(view.find('[data-flow-node="confidence"]')!.getAttribute('data-taken')).toBe('true');
    expect(view.find('.decision[data-finding-id="f-1"]')!.getAttribute('data-traced')).toBe('true');
    await view.unmount();
  });
});

describe('where a run spent its time, and what was left', () => {
  const run: AnalysisRun = {
    run_id: 'r-2', human_subject: 'testuser', started_at: '2026-09-09T00:00:00Z', updated_at: '2026-09-09T00:00:04Z',
    status: 'running', stage: 'analyze', completed_stages: ['collect', 'normalize', 'validateProtocol', 'detectRules', 'correlate', 'score'],
    stage_started_at: '2026-09-09T00:00:04Z', stage_durations_ms: { collect: 1000, score: 500 },
    input_count: 10, normalized_count: 8, unmapped_count: 2, violation_count: 2, rule_hit_count: 1, error_code: null,
    decisions: [decision({ state: 'analyzing', reason: 'score_requires_ai' }), decision({ finding_id: 'f-2', score: 5, level: 'LOW' })],
  };

  it('draws a segment per recorded stage and grows the running one with the clock', () => {
    const html = render(createElement(StageTiming, { run, now: Date.parse('2026-09-09T00:00:06Z'), labels: STAGE_LABELS }));
    expect(html).toContain('data-stage="collect" data-state="done"');
    expect(html).toContain('data-stage="analyze" data-state="running"');
    expect(html).not.toContain('data-stage="respond"');
    expect(html).toContain('1.0 秒');
    expect(html).toContain('2.0 秒');
  });

  it('counts what each stage let through and which findings reached the model', () => {
    const html = render(createElement(CountFunnel, { run }));
    expect(html).toMatch(/data-count="input"[\s\S]*?<b>10<\/b>/);
    expect(html).toMatch(/data-count="analysed"[\s\S]*?<b>1<\/b>/);
    expect(html).toContain('未対応の形式 2 件');
  });
});

describe('the mark beside a step', () => {
  const record = (overrides: Partial<ActivityRecord>): ActivityRecord => ({ headline: 'h', sections: [], ...overrides });

  it('reads the verdict off the checks, the hops and the failure section', () => {
    expect(stepVerdict(record({ checks: [{ id: 'c', label: 'l', result: 'blocked', message: 'm' }] }))).toBe('blocked');
    expect(stepVerdict(record({ hops: [{ from: 'agent-runtime', to: 'resource-api', label: 'l', outcome: 'blocked', message: 'm' }] }))).toBe('blocked');
    expect(stepVerdict(record({ sections: [{ id: 'failure', label: 'l' }] }))).toBe('failed');
    expect(stepVerdict(record({ hops: [{ from: 'resource-api', to: 'agent-runtime', label: 'l', outcome: 'success', message: 'm' }] }))).toBe('success');
    expect(stepVerdict(record({}))).toBe('info');
    expect(checkCounts(record({ checks: [
      { id: 'a', label: 'l', result: 'passed', message: 'm' }, { id: 'b', label: 'l', result: 'passed', message: 'm' },
      { id: 'c', label: 'l', result: 'skipped', message: 'm' },
    ] }))).toEqual({ passed: 2, blocked: 0, failed: 0, skipped: 1 });
  });

  it('joins hops that hand over where the last one landed', () => {
    const stops = routeStops([
      { from: 'agent-runtime', to: 'agent-op', label: 'a', outcome: 'info', message: 'm' },
      { from: 'agent-op', to: 'agent-runtime', label: 'b', outcome: 'success', message: 'm' },
      { from: 'agent-runtime', to: 'resource-api', label: 'c', outcome: 'blocked', message: 'm' },
    ]);
    expect(stops.map((stop) => stop.node)).toEqual(['agent-runtime', 'agent-op', 'agent-runtime', 'resource-api']);
    expect(stops.map((stop) => stop.arrival?.label)).toEqual([undefined, 'a', 'b', 'c']);
  });

  it('draws a refused hop as an arrow with a stop and a box not reached', () => {
    const html = render(createElement(RouteStrip, { hops: [
      { from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: 'm' },
      { from: 'agent-op', to: 'resource-api', label: '実行の要求', outcome: 'blocked', message: 'm' },
    ] }));
    expect(html).toContain('data-route-node="agent-runtime"');
    expect(html).toContain('Agent の身元発行');
    expect(html).toContain('title="Agent OP"');
    expect(html).toContain('route-stop-mark');
    expect(html).toMatch(/data-route-node="resource-api" data-hop-outcome="blocked"[\s\S]*?data-reached="false"/);
    expect(html).toContain('ID-JAG を要求');
    expect(render(createElement(RouteStrip, { hops: [] }))).toBe('');
  });

  it('puts a ribbon over the execution log and the verdict on each step', () => {
    const html = render(createElement(ExecutionLog, { records: [
      { headline: 'a', step: 1, sections: [], checks: [{ id: 'c', label: 'l', result: 'passed', message: 'm' }],
        hops: [{ from: 'agent-runtime', to: 'resource-api', label: 'GET /documents', outcome: 'info', message: 'm' },
          { from: 'resource-api', to: 'agent-runtime', label: 'HTTP 200', outcome: 'success', message: 'm' }] },
      { headline: 'b', step: 2, duration_ms: 1500, sections: [{ id: 'failure', label: '止まったところ' }] },
    ] }));
    expect(html).toContain('data-step-ribbon="true"');
    expect(html).toMatch(/data-step="1" data-verdict="success"/);
    expect(html).toMatch(/data-step="2" data-verdict="failed"/);
    expect(html).toMatch(/data-execution-step="2" data-verdict="failed"/);
    expect(html).toContain('data-check="passed"');
    expect(html).toContain('data-route-strip="true"');
    expect(html).toContain('1.5 秒');
  });
});

describe('the shape of a story', () => {
  const stamp = (overrides: Record<string, unknown>) => ({
    trace_id: 'tr', human_subject: 'testuser', agent_id: 'r', task_id: 'task-1', source: 'agent-runtime', phase: 'tool_call',
    outcome: 'success', title: 't', message: 'm', related_finding_id: null, is_simulated: false, ...overrides,
  });
  const blockedTask = {
    run_id: 'r', task_id: 'task-1', agent_id: 'r', purpose: 'p', status: 'completed' as const, terminal_outcome: 'blocked',
    completed_at: '2026-01-01T00:00:02.500Z',
    events: [
      stamp({ event_id: 'a', occurred_at: '2026-01-01T00:00:00.000Z' }),
      stamp({ event_id: 'b', occurred_at: '2026-01-01T00:00:01.000Z', outcome: 'blocked' }),
      stamp({ event_id: 'c', occurred_at: '2026-01-01T00:00:02.500Z', outcome: 'blocked' }),
    ],
  };

  it('draws a dot per event on the line, coloured by outcome, and says how long it took', () => {
    const html = render(createElement(TaskRow, { task: blockedTask as never }));
    expect(html.match(/class="shape-dot"/g)).toHaveLength(3);
    expect(html).toContain('data-outcome="blocked" data-phase="tool_call"');
    expect(html).toContain('3 件のできごと');
    expect(html).toContain('所要 2 秒');
    expect(html).toContain('遮断 2 件');
    expect(html).toContain('data-issue-count="2"');
    const running = render(createElement(TaskRow, { task: { run_id: 'r', task_id: 'task-2', agent_id: 'r', purpose: 'p', status: 'running' } }));
    expect(running).not.toContain('task-shape');
  });

  it('counts a failed end as a failure, once, even when the event was recorded as information', () => {
    const html = render(createElement(TaskRow, { task: {
      ...blockedTask, task_id: 'task-3', terminal_outcome: 'failed',
      events: [stamp({ event_id: 'f', task_id: 'task-3', occurred_at: '2026-01-01T00:00:00.000Z', outcome: 'info' })],
    } as never }));
    expect(html).toContain('失敗 1 件');
    expect(html).toContain('data-issue-count="1"');
    expect(html).toContain('data-emphasis="ev-failed"');
  });

  it('caps the dots and says how many are left', () => {
    const shape = Array.from({ length: 30 }, () => ({ phase: 'tool_call', outcome: 'success' }));
    const html = render(createElement(TaskShape, { shape }));
    expect(html.match(/class="shape-dot"/g)).toHaveLength(24);
    expect(html).toContain('+6');
    expect(html).toContain('title="1. ツールの実行 · 成功"');
  });

  it('turns counts into one bar with every segment named', () => {
    const html = render(createElement(OutcomeBar, { label: 'タスクの結果', counts: { success: 3, blocked: 1, failed: 0, running: 2 } }));
    expect(html).toContain('data-outcome="success"');
    expect(html).toContain('data-outcome="running"');
    expect(html).not.toContain('data-outcome="failed"');
    expect(html).toContain('遮断 <b>1</b>');
    expect(render(createElement(OutcomeBar, { label: 'x', counts: { success: 0, blocked: 0, failed: 0 } }))).toBe('');
  });

  it('runs a rail down the account and says how long after the last row each one came', () => {
    const events = [
      { event_id: 'e1', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', title: 't', message: 'm' },
      { event_id: 'e2', occurred_at: '2026-01-01T00:00:01.200Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'blocked', title: 't', message: 'm',
        record: { headline: 'h', sections: [], hops: [{ from: 'agent-runtime', to: 'resource-api', label: '実行の要求', outcome: 'blocked', message: 'm' }] } },
    ];
    const html = render(createElement(EventLog, { taskId: 'task-1', events }));
    expect(html.match(/class="event-rail"/g)).toHaveLength(2);
    expect(html).toContain('class="event-rail" data-outcome="blocked"');
    expect(html).toContain('data-field="event-elapsed"');
    expect(html).toContain('+1.2 秒');
    // The route stands still beside the lines, in the chosen event's record, not on every line.
    expect(html).not.toContain('route-strip');
    expect(render(createElement(EventDetail, { event: events[1]!, order: 2, total: 2 }))).toContain('class="route-strip"');
  });
});

describe('how far a failure exercise has got', () => {
  it('fills the dots as the request travels, and crosses them when it never will', () => {
    expect(trialStepStates('queued')).toEqual({ requested: 'done', received: 'current', confirmed: 'waiting' });
    expect(trialStepStates('failed')).toEqual({ requested: 'done', received: 'done', confirmed: 'done' });
    expect(trialStepStates('not_applied')).toEqual({ requested: 'done', received: 'skipped', confirmed: 'skipped' });
    const html = render(createElement(TrialTracker, { trial: {
      instruction_id: 'ins_1', task_id: 'task-1', kind: 'model_unavailable', created_at: '2026-01-01T00:00:00Z', applied_at: null, state: 'received',
    } }));
    expect(html).toContain('data-trial-step="received" data-step-state="done"');
    expect(html).toContain('data-trial-step="confirmed" data-step-state="current"');
    expect(html).toContain('応答なしによる打ち切りを確認');
  });
});
