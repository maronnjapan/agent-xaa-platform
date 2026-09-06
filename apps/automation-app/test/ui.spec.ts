/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import {
  NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_HEIGHT, REPLAY_NODES, REPLAY_VIEWBOX, SOURCE_TO_NODE, nodeIdFor, visibleNodeIds,
} from '../src/ui/replay/nodes.js';
import { EMPHASIS_CLASSES, EMPHASIS_LABELS, emphasisClass } from '../src/ui/replay/emphasis.js';
import { buildReplayPlan, isFinished } from '../src/ui/replay/plan.js';
import { alongRoute, buildFrame } from '../src/ui/replay/geometry.js';
import { REPLAY_MOTION_MS, REPLAY_STEP_MS, BLOCKED_STOP_RATIO } from '../src/ui/replay/config.js';
import { OutcomeBadge } from '../src/ui/components/outcome-badge.js';
import { DetailDisclosure } from '../src/ui/components/detail-disclosure.js';
import { ReplayCanvas } from '../src/ui/components/replay-canvas.js';
import { RunReplay } from '../src/ui/components/run-replay.js';
import { TaskRow } from '../src/ui/components/task-row.js';
import { AgentDetailPage } from '../src/ui/pages/agent-detail.js';
import { TimelinePage } from '../src/ui/pages/timeline.js';
import { BLOCKED_GUIDANCE_TEXT } from '../src/ui/components/blocked-guidance.js';
import { TIMELINE_NOTE } from '../src/ui/components/timeline-link.js';
import { SIMULATED_LABEL } from '../src/ui/components/simulated-badge.js';
import { LocalTime } from '../src/ui/components/local-time.js';
import { REPLAY_CAPTION_IDLE } from '../src/ui/components/replay-canvas.js';
import { html as render, mount } from './render.js';


/**
 * One finished task, mounted the way the timeline mounts it: the picture in
 * 「動きを見る」 and its account in 「やったこと」, sharing one step index.
 */
function oneTask(input: { taskId: string; taskKey: string; events: Array<Record<string, unknown>> }) {
  return createElement(RunReplay, {
    runId: 'run',
    tasks: [{
      taskId: input.taskId,
      taskKey: input.taskKey,
      purpose: '作業',
      completedAt: '2026-01-01T00:00:10.000Z',
      events: input.events as never,
      logEvents: input.events as never,
      simulated: false,
    }],
  });
}

describe('the replay diagram', () => {
  it('has 8 nodes with fixed coordinates', () => {
    expect(REPLAY_NODES).toHaveLength(8);
    expect(REPLAY_NODES.map((node) => node.id)).toEqual([
      'human-user', 'automation-app', 'authorization-platform', 'agent-provisioner',
      'agent-op', 'agent-runtime', 'resource-as', 'resource-api',
    ]);
    expect(REPLAY_NODES.map((node) => [node.x, node.y])).toEqual([
      [80, 60], [260, 60], [440, 60], [620, 60], [80, 220], [260, 220], [440, 220], [620, 220],
    ]);
    expect(REPLAY_VIEWBOX).toBe('0 0 720 300');
  });

  it('gives lifecycle-manager and security-detection no node', () => {
    expect(nodeIdFor('lifecycle-manager')).toBeNull();
    expect(nodeIdFor('security-detection')).toBeNull();
    expect(Object.values(SOURCE_TO_NODE).every((id) => REPLAY_NODES.some((node) => node.id === id))).toBe(true);
  });

  it('shows only the nodes a task involved', () => {
    const provisioning = render(ReplayCanvas({
      taskId: 'provisioning',
      visible: visibleNodeIds([{ source: 'automation-app', detail: { target: 'authorization-platform' } }]),
      state: 'idle',
      total: 1,
    }));
    expect(provisioning).toMatch(/data-node="authorization-platform"(?![^>]*hidden)/);

    const toolCall = render(ReplayCanvas({
      taskId: 'task-1',
      visible: visibleNodeIds([{ source: 'agent-runtime', detail: { target: 'resource-api' } }]),
      state: 'idle',
      total: 1,
    }));
    expect(toolCall).toMatch(/data-node="authorization-platform"[^>]*hidden/);
    expect(toolCall).toMatch(/data-node="resource-api"(?![^>]*hidden)/);
  });

  it('marks every node unreached before anything plays', () => {
    const html = render(ReplayCanvas({
      taskId: 'task-1', visible: visibleNodeIds([{ source: 'agent-runtime' }]), state: 'idle', total: 1,
    }));
    expect(html.match(/data-reached="false"/g)).toHaveLength(8);
    expect(html).toContain('data-replay-state="idle"');
  });

  it('computes the visible set from sources and targets together', () => {
    expect(visibleNodeIds([{ source: 'agent-runtime', detail: { target: 'resource-as' } }]))
      .toEqual(new Set(['agent-runtime', 'resource-as']));
  });

});

describe('the replay plan', () => {
  const events = [
    { event_id: 'b', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', outcome: 'success', message: '二番目', detail: { target: 'resource-as' } },
    { event_id: 'a', occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', outcome: 'info', message: '一番目', detail: { target: 'agent-runtime' } },
    { event_id: 'c', occurred_at: '2026-01-01T00:03:00.000Z', source: 'agent-runtime', outcome: 'blocked', message: '許可された Tool に含まれない', detail: { target: 'resource-api' } },
  ];

  it('orders by occurred_at then event_id', () => {
    const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan.map((step) => step.eventId)).toEqual(['a', 'b', 'c']);
  });

  it('paces every step identically whatever the real gap', () => {
    const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan.map((step) => step.delayMs)).toEqual([REPLAY_STEP_MS, REPLAY_STEP_MS, REPLAY_STEP_MS]);
  });

  /**
   * A step a person can read to the end. The motion is over in a second or so; the rest
   * of the step is the finished picture standing still with its caption under it, which
   * is the part that gets read. Under four seconds the sentence went past unfinished;
   * over five, a tool call's four exchanges become a wait.
   */
  it('leaves every step standing for seconds, not for the length of its motion', () => {
    expect(REPLAY_STEP_MS).toBeGreaterThanOrEqual(4_000);
    expect(REPLAY_STEP_MS).toBeLessThanOrEqual(5_000);
    expect(REPLAY_MOTION_MS).toBeGreaterThanOrEqual(1_000);
    expect(REPLAY_MOTION_MS).toBeLessThanOrEqual(2_000);
    // Most of a step is the picture standing still, not the dot moving.
    expect(REPLAY_STEP_MS - REPLAY_MOTION_MS).toBeGreaterThanOrEqual(REPLAY_MOTION_MS);
  });

  /**
   * REQ-11-025. Two steps, one 200ms apart and one three minutes apart, take the same
   * time on screen. A replay paced by the real clock would either race past the fast
   * part or leave a person watching nothing for three minutes.
   */
  it('gives a 200ms gap and a three minute gap the same step length', () => {
    const paced = buildReplayPlan([
      { event_id: 'a', occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', outcome: 'info', message: '一', detail: { target: 'agent-runtime' } },
      { event_id: 'b', occurred_at: '2026-01-01T00:00:00.200Z', source: 'agent-runtime', outcome: 'success', message: '二', detail: { target: 'resource-as' } },
      { event_id: 'c', occurred_at: '2026-01-01T00:03:00.200Z', source: 'agent-runtime', outcome: 'success', message: '三', detail: { target: 'resource-api' } },
    ], (source) => SOURCE_TO_NODE[source] ?? null);
    const intervals = paced.slice(1).map((step) => step.delayMs);
    expect(new Set(intervals)).toEqual(new Set([REPLAY_STEP_MS]));
    expect(Math.abs(intervals[0]! - intervals[1]!)).toBeLessThanOrEqual(100);
  });

  it('stops a blocked step short of its destination', () => {
    const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan[2]).toMatchObject({ blocked: true, stopRatio: BLOCKED_STOP_RATIO, to: 'resource-api' });
    expect(plan.filter((step) => step.blocked)).toHaveLength(1);
    expect(BLOCKED_STOP_RATIO).toBe(0.6);
  });

  it('continues after a blocked step', () => {
    const plan = buildReplayPlan([...events, {
      event_id: 'd', occurred_at: '2026-01-01T00:04:00.000Z', source: 'agent-runtime', outcome: 'success', message: '続き',
    }], (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan).toHaveLength(4);
    expect(isFinished(plan, 2)).toBe(false);
    expect(isFinished(plan, 3)).toBe(true);
  });

  it('gives a nodeless event no endpoints', () => {
    const plan = buildReplayPlan([{
      event_id: 'x', occurred_at: '2026-01-01T00:00:00.000Z', source: 'security-detection', outcome: 'blocked', message: '検知',
    }], (source) => SOURCE_TO_NODE[source] ?? null);
    expect(plan[0]).toMatchObject({ from: null, to: null });
  });

});

describe('emphasis', () => {
  it('distinguishes a blocked security event from a blocked tool call', () => {
    expect(emphasisClass('blocked', 'security')).toBe('ev-blocked-security');
    expect(emphasisClass('blocked', 'tool_call')).toBe('ev-blocked-tool');
    expect(emphasisClass('blocked', 'security')).not.toBe(emphasisClass('blocked', 'tool_call'));
    expect(new Set(EMPHASIS_CLASSES).size).toBe(4);
  });

  it('gives all four a text label, not only a colour', () => {
    const rendered = [
      render(OutcomeBadge({ outcome: 'info', phase: 'login' })),
      render(OutcomeBadge({ outcome: 'success', phase: 'tool_call' })),
      render(OutcomeBadge({ outcome: 'blocked', phase: 'tool_call' })),
      render(OutcomeBadge({ outcome: 'blocked', phase: 'security' })),
    ];
    for (const [index, html] of rendered.entries()) {
      expect(html).toContain(EMPHASIS_LABELS[EMPHASIS_CLASSES[index]!]);
    }
    expect(new Set(rendered.map((html) => /data-emphasis="([^"]+)"/.exec(html)![1]))).toHaveLength(4);
  });

  it('puts the warning icon on the security badge only', () => {
    expect(render(OutcomeBadge({ outcome: 'blocked', phase: 'security' }))).toContain('data-icon="warning"');
    expect(render(OutcomeBadge({ outcome: 'blocked', phase: 'tool_call' }))).not.toContain('data-icon="warning"');
  });
});

describe('the detail disclosure', () => {
  it('is closed to begin with', () => {
    const html = render(DetailDisclosure({ detail: { tool_id: 'internal.document.list' } }));
    expect(html).toContain('<details');
    expect(html).not.toContain(' open');
  });

  it('joins arrays with a Japanese separator and never composes a sentence', () => {
    const html = render(DetailDisclosure({ detail: { effective_capabilities: ['a', 'b'] } }));
    expect(html).toContain('a、b');
    expect(html).toContain('effective_capabilities');
  });

  it('renders nothing when the event has no detail', () => {
    expect(DetailDisclosure({})).toBeNull();
    expect(DetailDisclosure({ detail: {} })).toBeNull();
  });
});

describe('the task list', () => {
  it('renders a running task as a disabled button with no outcome', () => {
    const html = render(TaskRow({ task_id: 'task-1', purpose: '日報', status: 'running' }));
    expect(html).toContain('disabled');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('実行中');
  });

  it('renders a completed task with four columns', () => {
    const html = render(TaskRow({
      task_id: 'task-1', purpose: '日報', status: 'completed',
      terminal_outcome: 'blocked', completed_at: '2026-01-01T00:00:00.000Z', phase: 'tool_call',
    }));
    expect(html).toContain('data-task-id="task-1"');
    expect(html).toContain('data-outcome="blocked"');
    expect(html).not.toContain('disabled');
    for (const column of ['col-purpose', 'col-task-id', 'col-outcome', 'col-completed-at']) {
      expect(html).toContain(column);
    }
  });

  it('labels a simulated task everywhere and a real one nowhere', () => {
    const simulated = render(createElement(TimelinePage, {
      tasks: [{
        run_id: 'demo:demo-dpop-replay', task_id: 'demo-dpop-replay', agent_id: null, purpose: 'デモ', status: 'completed',
        terminal_outcome: 'blocked', completed_at: '2026-01-01T00:00:00.000Z',
        events: [{
          event_id: 'e', trace_id: 't', human_subject: 'testuser', agent_id: null, task_id: 'demo-dpop-replay',
          occurred_at: '2026-01-01T00:00:00.000Z', source: 'security-detection', phase: 'security', outcome: 'blocked',
          title: 'x', message: 'y', detail: { event_type: 'DPOP_REPLAY' }, related_finding_id: null, is_simulated: true,
        }],
      }],
    }));
    // Row, canvas and detail summary: three places, none of them behind a disclosure
    // that starts closed.
    expect(simulated.match(new RegExp(SIMULATED_LABEL, 'g'))).toHaveLength(3);
    expect(simulated).toContain('simulated-row');
    expect(simulated).toContain('simulated-canvas');
    // With every disclosure shut, the label is still on the page twice: once on the row
    // and once on the canvas. A badge only inside `<details>` would be invisible to
    // anyone who never opened one (RULE-58).
    expect(simulated).not.toContain('<details open');
    const outsideDisclosures = simulated.split(/<details[\s\S]*?<\/details>/g).join('');
    expect(outsideDisclosures.match(new RegExp(SIMULATED_LABEL, 'g'))).toHaveLength(2);

    const real = render(createElement(TimelinePage, {
      tasks: [{ run_id: 'work:wd_1', task_id: 'task-1', agent_id: null, purpose: '実作業', status: 'running' }],
    }));
    expect(real).not.toContain(SIMULATED_LABEL);
  });
});

describe('the agent detail page', () => {
  const status = {
    agent_status: 'ACTIVE', remaining_seconds: 100, current_task: 'task-1',
    tool_invocations: [{ tool_id: 'internal.finance.payment.approve', outcome: 'blocked', summary: 'not_in_allowed_tools' }],
    execution_log: [],
  };

  it('separates the status panel from the timeline link', () => {
    const html = render(AgentDetailPage({ agentId: 'agent-a', status }));
    expect(html).toContain('data-section="status"');
    expect(html).toContain('data-section="timeline-link"');
    expect(html.indexOf('data-section="status"')).toBeLessThan(html.indexOf('data-section="timeline-link"'));
  });

  it('always shows the note about what the timeline replays', () => {
    const html = render(AgentDetailPage({ agentId: 'agent-a', status }));
    expect(html).toContain(TIMELINE_NOTE);
    // Outside any <details>: the caveat must be readable without opening anything.
    expect(html.split(/<details[\s\S]*?<\/details>/g).join('')).toContain(TIMELINE_NOTE);
  });

  it('offers one link, to a new ToDo, when something was blocked', () => {
    const html = render(AgentDetailPage({ agentId: 'agent-a', status }));
    expect(html).toContain(BLOCKED_GUIDANCE_TEXT);
    expect(html.match(/\/todos\/new/g)).toHaveLength(1);
    expect(html).not.toContain('権限を追加');
    expect(html).not.toContain('Capability を編集');
    expect(html).not.toContain('agent_id=agent-a&');
  });

  it('shows no guidance when nothing was blocked', () => {
    const html = render(AgentDetailPage({
      agentId: 'agent-a',
      status: { ...status, tool_invocations: [{ tool_id: 'internal.document.list', outcome: 'success', summary: '' }] },
    }));
    expect(html).not.toContain(BLOCKED_GUIDANCE_TEXT);
  });
});

describe('what the timeline asks for, and when', () => {
  /**
   * REQ-11-012 / DEV-13. The page is served with its records already on it and asks
   * again only when the refresh button is pressed. A minute of sitting still produces
   * no request at all, which is the browser-side half of "no live channel to the
   * datastore".
   */
  it('asks nothing on its own, and once per press of the refresh button', async () => {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const view = await mount(createElement(TimelinePage, { tasks: [] }));
      await view.act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(asked).toEqual([]);

      await view.act(() => { view.find('[data-action="refresh"]')!.click(); });
      await view.act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(asked).toEqual(['/api/activity/tasks']);
      await view.unmount();
    } finally {
      vi.useRealTimers();
      globalThis.fetch = original;
    }
  });
});

describe('the replay as it is drawn', () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'a', trace_id: 'tr', human_subject: 'testuser', agent_id: null, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime',
    phase: 'tool_call', outcome: 'success', title: 'やり取りの名前', message: '読みました',
    detail: { target: 'resource-api' }, related_finding_id: null, is_simulated: false, ...overrides,
  });

  /** The task as the page hands it to the replay: the events, twice, in both shapes. */
  async function play(events: Array<Record<string, unknown>>, steps = events.length + 1) {
    vi.useFakeTimers();
    const view = await mount(oneTask({ taskId: 'task-1', taskKey: 'run:task-1', events }));
    try {
      await view.act(() => { view.find('[data-action="replay-play"]')!.click(); });
      // One step at a time: each step's timer is registered by the effect that runs
      // after the step before it has been rendered, so they cannot all be run off in
      // one advance.
      for (let step = 0; step < steps; step += 1) {
        await view.act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_STEP_MS); });
      }
    } finally {
      vi.useRealTimers();
    }
    return view;
  }

  /**
   * One step's geometry, without a document: what the canvas is handed to draw.
   *
   * Every box is visible, which is the case a line has to survive — a box the replay
   * is not showing cannot be drawn over, so a task that involved two boxes is the easy
   * one and a task that involved all eight is the test.
   */
  const ALL_NODES = new Set(REPLAY_NODES.map((node) => node.id));
  const frameFor = (from: string, to: string, overrides: Record<string, unknown> = {}) => {
    const events = [event({ source: from, detail: { target: to }, ...overrides })];
    const plan = buildReplayPlan(events as never, (source) => SOURCE_TO_NODE[source] ?? null);
    return buildFrame(plan[0]!, ALL_NODES);
  };

  /** Points along a polyline, close enough together to catch a clipped corner. */
  const samples = (route: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> =>
    route.slice(1).flatMap((to, index) => {
      const from = route[index]!;
      return Array.from({ length: 41 }, (_unused, tick) => ({
        x: from.x + (to.x - from.x) * (tick / 40),
        y: from.y + (to.y - from.y) * (tick / 40),
      }));
    });

  /** One line of the label font, so a name near the frame's edge is not cut off. */
  const TEXT_HEIGHT = 11;

  it('gives each step a path and an animation paced by the motion length', async () => {
    const view = await play([event()]);
    const dot = view.find('.replay-dot')!;
    expect(dot.getAttribute('class')).toBe('replay-dot');
    // Agent Runtime is at (260, 220) and the path leaves the edge of its box, not its
    // centre: an arrow drawn from the centre is drawn underneath the box it left.
    expect(dot.style.getPropertyValue('offset-path')).toMatch(/^path\('M 330 220 /);
    expect(dot.style.getPropertyValue('--motion-ms')).toBe(`${REPLAY_MOTION_MS}ms`);
    expect(view.find('[data-arrows] path')).not.toBeNull();
    expect(view.find('[data-replay-state]')!.getAttribute('data-replay-state')).toBe('finished');
    await view.unmount();
  });

  /**
   * The picture's one geometric promise: a line and a name are about the two boxes at
   * the ends of the arrow, and about no other box. A straight centre-to-centre line
   * broke it twice over — it ran under the box it left, and a hop with a third box
   * between its ends was drawn straight through that third box, which reads as a call
   * that service was part of.
   *
   * Every ordered pair is checked rather than the handful the demo happens to produce:
   * which boxes a real task connects is not this file's to predict. It is arithmetic
   * over eight fixed coordinates, so it is checked as arithmetic, without a document.
   */
  it('draws no line and no name over a box the step is not about', () => {
    for (const from of REPLAY_NODES) {
      for (const to of REPLAY_NODES) {
        if (from.id === to.id) continue;
        const frame = frameFor(from.id, to.id);
        const others = REPLAY_NODES.filter((node) => node.id !== from.id && node.id !== to.id);

        for (const at of samples(frame.route)) {
          for (const node of others) {
            const clear = Math.abs(at.x - node.x) >= NODE_HALF_WIDTH || Math.abs(at.y - node.y) >= NODE_HALF_HEIGHT;
            expect(clear, `${from.id} → ${to.id} is drawn over ${node.id}`).toBe(true);
          }
        }

        // The name is placed by height alone, so it clears every box however wide the
        // text turns out to be — which the browser knows and this suite cannot.
        const y = frame.labelAt!.y;
        for (const node of REPLAY_NODES) {
          expect(Math.abs(y - node.y) >= NODE_HALF_HEIGHT, `the name of ${from.id} → ${to.id} sits on ${node.id}`).toBe(true);
        }
        expect(y).toBeGreaterThan(TEXT_HEIGHT);
        expect(y).toBeLessThan(REPLAY_HEIGHT);
      }
    }
  });

  /**
   * The plan's ratio alone put the stop mark on top of the Resource AS on this very
   * path — a refusal the Tool Executor made, drawn as if a service in the middle had
   * made it. The mark is walked back until it is clear of every box but the one the
   * movement left.
   */
  it('keeps a refusal mark off every box but the one it set off from', () => {
    const frame = frameFor('agent-runtime', 'resource-api', { outcome: 'blocked', message: '許可された Tool に含まれない' });
    expect(frame.stopRatio).toBeLessThanOrEqual(BLOCKED_STOP_RATIO);
    expect(frame.unreached).toBe('resource-api');
    expect(frame.reached).toBeNull();
    const at = alongRoute(frame.route, frame.stopRatio);
    for (const node of REPLAY_NODES) {
      if (node.id === 'agent-runtime') continue;
      const clear = Math.abs(at.x - node.x) > NODE_HALF_WIDTH || Math.abs(at.y - node.y) > NODE_HALF_HEIGHT;
      expect(clear, `the stop mark overlaps ${node.id}`).toBe(true);
    }
  });

  it('stops a blocked step short of the box and marks that one box unreached', async () => {
    const view = await play([event({ outcome: 'blocked', message: '許可された Tool に含まれない' })]);
    const dot = view.find('[data-blocked="true"]')!;
    expect(dot.getAttribute('class')).toBe('replay-dot is-blocked');
    expect(Number(dot.style.getPropertyValue('--stop-ratio'))).toBeLessThanOrEqual(BLOCKED_STOP_RATIO);
    expect(view.all('[data-blocked="true"]')).toHaveLength(1);
    expect(view.all('[data-stop="true"]')).toHaveLength(1);

    // Exactly one destination is refused, and every box the task never touched carries
    // no verdict at all — otherwise "the one that was not reached" means nothing.
    const unreached = view.all('[data-reached="false"]');
    expect(unreached).toHaveLength(1);
    expect(unreached[0]!.getAttribute('data-node')).toBe('resource-api');

    // The reason shown is the publisher's own sentence, put on screen unchanged.
    expect(view.text('[data-field="caption-message"]')).toBe('許可された Tool に含まれない');
    await view.unmount();
  });

  it('draws a blocked security event more strongly than a blocked tool call', async () => {
    const security = await play([event({ phase: 'security', outcome: 'blocked' })]);
    const tool = await play([event({ phase: 'tool_call', outcome: 'blocked' })]);
    expect(security.find('[data-blocked="true"]')!.getAttribute('data-emphasis'))
      .toBe(emphasisClass('blocked', 'security'));
    expect(tool.find('[data-blocked="true"]')!.getAttribute('data-emphasis'))
      .toBe(emphasisClass('blocked', 'tool_call'));
    await security.unmount();
    await tool.unmount();
  });

  /**
   * One step on the canvas, and it is the current one. The words used to pile up: four
   * steps left four sentences and four arrows on screen at once, which answered "what
   * is happening now" with everything that had ever happened. What did happen, in
   * order, is the written log beside the picture — server-rendered and never wiped.
   */
  it('shows the step it is on and nothing the steps before drew', async () => {
    // Handed over out of order, on purpose: the replay decides the order, from
    // `occurred_at`, not from however the events arrived.
    const view = await play([
      event({ event_id: 'c', occurred_at: '2026-01-01T00:09:00.000Z', title: '三', message: '三番目', detail: { target: 'resource-as' } }),
      event({ event_id: 'a', occurred_at: '2026-01-01T00:03:00.000Z', title: '一', message: '一番目' }),
      event({ event_id: 'd', occurred_at: '2026-01-01T00:12:00.000Z', title: '四', message: '四番目', detail: { target: 'resource-api' } }),
      event({ event_id: 'b', occurred_at: '2026-01-01T00:06:00.000Z', title: '二', message: '二番目', detail: { target: 'resource-as' } }),
    ]);
    expect(view.text('[data-field="caption-message"]')).toBe('四番目');
    expect(view.text('[data-field="caption-step"]')).toBe('4 / 4');
    expect(view.all('[data-arrows] path')).toHaveLength(1);
    expect(view.all('[data-arrow-label]')).toHaveLength(1);
    expect(view.all('.replay-dot')).toHaveLength(1);
    expect(view.all('[data-step-index]').map((drawn) => drawn.getAttribute('data-step-index')))
      .toEqual(['3', '3', '3']);
    await view.unmount();
  });

  /**
   * REQ-11-023. The last frame is where the replay stays. Looping it would make a
   * person watching for a second time unsure whether they were seeing new work.
   */
  it('leaves the finished replay alone several steps later', async () => {
    const view = await play([event({ message: '一番目' })]);
    const settled = view.text('[data-field="caption-message"]');
    expect(view.find('[data-replay-state]')!.getAttribute('data-replay-state')).toBe('finished');

    vi.useFakeTimers();
    try {
      await view.act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_STEP_MS * 3); });
    } finally {
      vi.useRealTimers();
    }
    expect(view.find('[data-replay-state]')!.getAttribute('data-replay-state')).toBe('finished');
    expect(view.text('[data-field="caption-message"]')).toBe(settled);
    expect(view.all('.replay-dot')).toHaveLength(1);
    await view.unmount();
  });

  /**
   * REQ-11-026. The disclosure belongs to the written log, and the replay only ever
   * re-renders what is inside the canvas — so the same `<details>` opens before a
   * replay, during one, and after it has finished.
   */
  it('leaves the detail disclosure openable before and after playing', async () => {
    const view = await play([event({ detail: { target: 'resource-api', tool_id: 'internal.document.list' } })]);
    const disclosures = view.all('[data-detail="true"]');
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]!.getAttribute('open')).toBeNull();
    await view.act(() => { (disclosures[0] as HTMLDetailsElement).open = true; });
    expect((disclosures[0] as HTMLDetailsElement).open).toBe(true);
    await view.unmount();
  });

  /**
   * The question the picture cannot answer on its own. The record's parts are sorted
   * into what the agent read, what it said, what it chose and what it made sure of,
   * and every one of those strings is the publisher's (RULE-54).
   */
  it('shows what the agent read, thought, decided and checked, on the step it is on', async () => {
    const view = await play([event({
      record: {
        headline: 'internal.document.list を実行しました',
        step: 1,
        checks: [{ id: 'allowed_tools', label: '許可されたツールに入っているか', result: 'passed', message: '含まれていました。' }],
        sections: [
          { id: 'received', label: 'この手で読んだ指示', text: '日報をまとめて', format: 'text' },
          { id: 'intent', label: 'エージェントが決めたこと', text: 'まず一覧を見る。', format: 'text', fields: [{ label: '選んだツール', value: 'internal.document.list' }] },
          { id: 'capability', label: 'このツールが要求する権限', fields: [{ label: '必要な Capability', value: 'document.read' }] },
        ],
      },
    })]);
    const panel = view.find('[data-thinking]')!;
    expect(panel.getAttribute('data-thinking-state')).toBe('playing');
    // Who was thinking, named the way the diagram names the same box.
    expect(view.text('[data-field="thinking-who"]')).toContain('Agent Runtime');
    expect(view.text('[data-field="thinking-headline"]')).toBe('internal.document.list を実行しました');
    expect(view.find('[data-beat="read"]')!.textContent).toContain('日報をまとめて');
    // The model's own words are a quotation, so they are not read as the screen's.
    expect(view.text('[data-field="thinking-quote"]')).toBe('まず一覧を見る。');
    expect(view.find('[data-beat="decided"]')!.textContent).toContain('document.read');
    expect(view.find('[data-beat="checks"]')!.textContent).toContain('含まれていました。');
    await view.unmount();
  });

  /** The written log follows the picture, one row at a time. */
  it('marks the log row the picture has reached', async () => {
    const events = [
      event({ event_id: 'a', occurred_at: '2026-01-01T00:01:00.000Z', message: '一番目' }),
      event({ event_id: 'b', occurred_at: '2026-01-01T00:02:00.000Z', message: '二番目' }),
    ];
    vi.useFakeTimers();
    const view = await mount(oneTask({ taskId: 'task-1', taskKey: 'run:task-1', events }));
    try {
      expect(view.all('[data-entry-state="waiting"]')).toHaveLength(2);
      await view.act(() => { view.find('[data-action="replay-step"]')!.click(); });
      expect(view.find('[data-event-id="a"]')!.getAttribute('data-entry-state')).toBe('current');
      expect(view.find('[data-event-id="b"]')!.getAttribute('data-entry-state')).toBe('waiting');
      await view.act(() => { view.find('[data-action="replay-step"]')!.click(); });
      expect(view.find('[data-event-id="a"]')!.getAttribute('data-entry-state')).toBe('played');
      expect(view.find('[data-event-id="b"]')!.getAttribute('data-entry-state')).toBe('current');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });
});

describe('the replay as it speaks', () => {
  const event = (overrides: Record<string, unknown>) => ({
    event_id: 'a', trace_id: 'tr', human_subject: 'testuser', agent_id: null, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
    title: 't', message: 'm', related_finding_id: null, is_simulated: false, ...overrides,
  });

  async function play(events: Array<Record<string, unknown>>) {
    vi.useFakeTimers();
    const view = await mount(oneTask({ taskId: 'task-1', taskKey: 'agent-a:task-1', events }));
    try {
      await view.act(() => { view.find('[data-action="replay-play"]')!.click(); });
      for (let step = 0; step < events.length + 2; step += 1) {
        await view.act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_STEP_MS); });
      }
    } finally {
      vi.useRealTimers();
    }
    return view;
  }

  it('writes the route, the exchange and the sentence under the picture, and on the arrow', async () => {
    const view = await play([event({
      record: { headline: 'h', sections: [], hops: [{ from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: 'Agent OP に身元を求めました。' }] },
    })]);
    expect(view.text('[data-field="caption-step"]')).toBe('1 / 1');
    expect(view.text('[data-field="caption-route"]')).toBe('Agent Runtime → Agent OP');
    expect(view.text('[data-field="caption-label"]')).toBe('ID-JAG を要求');
    expect(view.text('[data-field="caption-message"]')).toBe('Agent OP に身元を求めました。');
    expect(view.find('[data-caption]')!.getAttribute('data-caption-state')).toBe('playing');
    const labels = view.all('[data-arrow-label]');
    expect(labels).toHaveLength(1);
    expect(labels[0]!.textContent).toBe('ID-JAG を要求');
    // The two boxes involved are lit, told apart, and nothing else is.
    const lit = view.all('[data-node]').filter((node) => node.getAttribute('data-active') !== '');
    expect(lit.map((node) => [node.getAttribute('data-node'), node.getAttribute('data-active')]))
      .toEqual([['agent-op', 'to'], ['agent-runtime', 'from']]);
    await view.unmount();
  });

  it('pulses the box for a step that stayed inside it', async () => {
    const view = await play([event({
      source: 'authorization', phase: 'authorization', outcome: 'info', title: '権限を決定しました', message: '許可：x',
      detail: {},
    })]);
    expect(view.all('[data-pulse="true"]')).toHaveLength(1);
    expect(view.all('[data-arrow-label]')).toHaveLength(0);
    expect(view.text('[data-field="caption-route"]')).toBe('Authorization Platform');
    expect(view.text('[data-field="caption-label"]')).toBe('権限を決定しました');
    const box = view.find('[data-node="authorization-platform"]')!;
    expect(box.getAttribute('data-active')).toBe('self');
    expect(box.getAttribute('data-reached')).toBe('true');
    await view.unmount();
  });

  it('serves the caption empty and explains what will appear there', () => {
    const html = render(ReplayCanvas({
      taskId: 'task-1', taskKey: 'agent-a:task-1',
      visible: new Set(['agent-runtime']), state: 'idle', total: 1,
    }));
    expect(html).toContain('data-caption="true"');
    expect(html).toContain('data-caption-state="idle"');
    expect(html).toContain(REPLAY_CAPTION_IDLE);
    expect(html).toContain('data-labels="true"');
    expect(html).toContain('data-replay-key="agent-a:task-1"');
  });
});

describe('the recorded instants in the reader\'s clock', () => {
  /**
   * The page is served with the instant as it was recorded, in UTC, which is what a
   * reader with no script still sees; once the browser has the page the text is re-set
   * to the same instant in the reader's own zone. Both are asserted, because the point
   * is that they are the same instant said twice, and that the record survives.
   */
  it('serves the recorded value and rewrites the text once the browser has it', async () => {
    // HTML attribute names are case-insensitive, so React's `dateTime` is the same
    // `datetime` attribute once a browser has parsed it.
    expect(render(createElement(LocalTime, { at: '2026-01-01T00:00:00.000Z' })))
      .toMatch(/datetime="2026-01-01T00:00:00\.000Z"/i);

    const view = await mount(createElement(LocalTime, { at: '2026-01-01T00:00:00.000Z' }));
    const shown = view.find('time')!;
    expect(shown.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
    expect(shown.getAttribute('title')).toBe('2026-01-01T00:00:00.000Z');
    expect(shown.textContent).not.toBe('2026-01-01T00:00:00.000Z');
    expect(shown.textContent).toMatch(/2026/);
    await view.unmount();
  });

  it('leaves a value it cannot read alone', async () => {
    const view = await mount(createElement(LocalTime, { at: 'not a time' }));
    expect(view.find('time')!.textContent).toBe('not a time');
    await view.unmount();
  });
});

/**
 * The controls exist because a replay that only ran once, start to finish, at a fixed
 * pace, is a thing you watch rather than a thing you read. The step that says something
 * surprising is exactly the one a person wants to stop on and read the record under.
 */
describe('the replay as a thing a person can stop', () => {
  const events = [
    { event_id: 'ev-1', trace_id: 'tr', human_subject: 'testuser', agent_id: null, task_id: 'task-1', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', title: '一', message: '一番目', detail: { target: 'resource-as' }, related_finding_id: null, is_simulated: false },
    { event_id: 'ev-2', trace_id: 'tr', human_subject: 'testuser', agent_id: null, task_id: 'task-1', occurred_at: '2026-01-01T00:01:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', title: '二', message: '二番目', detail: { target: 'resource-api' }, related_finding_id: null, is_simulated: false },
  ];

  const open = () => mount(oneTask({ taskId: 'task-1', taskKey: 'agent-a:task-1', events }));

  const states = (view: Awaited<ReturnType<typeof mount>>): (string | null)[] =>
    view.all('[data-event-id]').map((entry) => entry.getAttribute('data-entry-state'));

  it('counts the steps as it goes', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      await view.act(() => { view.find('[data-action="replay-play"]')!.click(); });
      for (let step = 0; step < 3; step += 1) {
        await view.act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_STEP_MS); });
      }
    } finally {
      vi.useRealTimers();
    }
    expect(view.text('[data-field="replay-progress"]')).toBe('2 / 2');
    expect(view.find('[data-replay-state]')!.getAttribute('data-replay-state')).toBe('finished');
    await view.unmount();
  });

  it('marks the entry it is on, and the ones it has passed', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      await view.act(() => { view.find('[data-action="replay-play"]')!.click(); });
      expect(states(view)).toEqual(['current', 'waiting']);

      await view.act(() => { view.find('[data-action="replay-pause"]')!.click(); });
      expect(view.find('[data-replay-state]')!.getAttribute('data-replay-state')).toBe('paused');
      // Paused after one step, so the boundary between shown and not-shown holds.
      await view.act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_STEP_MS * 5); });
      expect(states(view)).toEqual(['current', 'waiting']);

      await view.act(() => { view.find('[data-action="replay-step"]')!.click(); });
      expect(states(view)).toEqual(['played', 'current']);
      expect(view.find('[data-replay-state]')!.getAttribute('data-replay-state')).toBe('finished');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  it('steps one at a time without ever starting the clock', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      expect(view.all('.replay-dot')).toHaveLength(0);
      await view.act(() => { view.find('[data-action="replay-step"]')!.click(); });
      expect(view.text('[data-field="caption-message"]')).toBe('一番目');
      // Nothing is scheduled: a paused replay stays where it was put.
      await view.act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_STEP_MS * 5); });
      expect(view.text('[data-field="caption-message"]')).toBe('一番目');
      expect(view.text('[data-field="caption-step"]')).toBe('1 / 2');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  /** A box can be pressed for what it is, which is the question the names raise. */
  it('opens the description of a box when it is pressed', async () => {
    const view = await open();
    expect(view.find('[data-role-open]')).toBeNull();
    await view.click('[data-node="agent-runtime"]');
    const opened = view.find('[data-role-open="agent-runtime"]')!;
    expect(opened.textContent).toContain('Agent が動く場所');
    expect(opened.querySelector('[data-field="role-does-not"]')!.textContent).not.toBe('');
    await view.click('[data-action="close-role"]');
    expect(view.find('[data-role-open]')).toBeNull();
    await view.unmount();
  });
});
