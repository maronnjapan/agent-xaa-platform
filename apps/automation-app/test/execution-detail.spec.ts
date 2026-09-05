import { describe, expect, it, vi } from 'vitest';
import { validateActivityEvent, type ActivityEvent, type ActivityRecord } from '@xaa/contracts';
import { storeActivityEvent } from '../src/activity/subscriber.js';
import { readTimeline } from '../src/activity/query.js';
import { RecordView } from '../src/ui/components/record-view.js';
import { EventLog, EVENT_LOG_CAPTION } from '../src/ui/components/event-log.js';
import { ExecutionLog, EXECUTION_LOG_EMPTY, EXECUTION_LOG_HEADING } from '../src/ui/components/execution-log.js';
import { ReplayCanvas, REPLAY_LEGEND } from '../src/ui/components/replay-canvas.js';
import { AgentDetailPage } from '../src/ui/pages/agent-detail.js';
import { TimelinePage } from '../src/ui/pages/timeline.js';
import { REPLAY_NODES, visibleNodeIds } from '../src/ui/replay/nodes.js';
import { buildReplayPlan } from '../../automation-app/client/src/replay-plan.js';
import { playReplay } from '../../automation-app/client/src/replay.js';
import { REPLAY_STEP_MS } from '../../automation-app/client/src/replay-config.js';
import { FakeDocument, FakeElement, element } from './fake-dom.js';
import { AGENT_ID, SUBJECT, startAutomationApp } from './helpers.js';

const render = async (node: unknown): Promise<string> => String(await node);

/**
 * One tool call as the Runtime records it: what the agent decided, what it checked,
 * where it sent what, what came back, and the four exchanges it took to get there.
 */
const record: ActivityRecord = {
  headline: 'internal.document.list を実行しました',
  step: 1,
  checks: [
    { id: 'allowed_tools', label: '許可されたツールに入っているか', result: 'passed', message: '2 件に含まれていました。' },
    { id: 'constraints', label: '人が付けた条件を満たすか', result: 'blocked', message: '上限を超えていました。' },
  ],
  sections: [
    {
      id: 'request',
      label: '送ったリクエスト',
      message: 'GET で呼びました。',
      fields: [{ label: 'メソッド', value: 'GET' }, { label: '宛先', value: 'https://docs.example.test/documents' }],
      text: '{"limit":10}',
      format: 'json',
    },
    { id: 'intent', label: 'エージェントが決めたこと', text: 'まず一覧を取ります。', format: 'text' },
  ],
  hops: [
    { from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: '身元を求めました。' },
    { from: 'agent-op', to: 'agent-runtime', label: 'ID-JAG を受領', outcome: 'success', message: '発行されました。' },
    { from: 'agent-runtime', to: 'resource-api', label: 'GET /documents', outcome: 'blocked', message: '止められました。' },
  ],
};

describe('the record panel', () => {
  it('shows every word its publisher wrote, and adds none of its own', async () => {
    const html = await render(RecordView({ record }));
    for (const text of [
      record.headline,
      '許可されたツールに入っているか', '2 件に含まれていました。',
      '送ったリクエスト', 'GET で呼びました。', 'https://docs.example.test/documents',
      'まず一覧を取ります。',
    ]) {
      expect(html).toContain(text);
    }
    // The body as it was sent, escaped for the page rather than reformatted for it.
    expect(html).toContain('{&quot;limit&quot;:10}');
  });

  /**
   * REQ-11-002. The renderer lays out labels and values; it never turns one into a
   * sentence. A screen that phrased a status code as 「拒否されました」 would be judging
   * a record it did not make, and would rewrite the past when its wording changed.
   */
  it('never turns a value into a verdict of its own', async () => {
    const bare = await render(RecordView({
      record: { headline: 'h', sections: [{ id: 's', label: 'ラベル', fields: [{ label: 'HTTP ステータス', value: '403' }] }] },
    }));
    expect(bare).toContain('403');
    for (const invented of ['拒否されました', '失敗しました', 'エラー']) expect(bare).not.toContain(invented);
  });

  it('shows the checks in the open and folds the technical values away', async () => {
    const html = await render(RecordView({ record }));
    // The checks answer "did anything stop this", so they are not behind a disclosure.
    const outsideDisclosures = html.split(/<details[\s\S]*?<\/details>/g).join('');
    expect(outsideDisclosures).toContain('許可されたツールに入っているか');
    expect(outsideDisclosures).not.toContain('{&quot;limit&quot;:10}');
    expect(html).toContain('data-check-result="blocked"');
    expect(html).not.toContain('<details open');
  });

  it('renders nothing at all when an event has no breakdown', () => {
    expect(RecordView({})).toBeNull();
  });
});

describe('the execution log on the agent screen', () => {
  it('says so plainly when the agent has not done anything yet', async () => {
    const html = await render(ExecutionLog({ records: [] }));
    expect(html).toContain(EXECUTION_LOG_HEADING);
    expect(html).toContain(EXECUTION_LOG_EMPTY);
  });

  /** The beginning and the end are what people open; the middle is one click away. */
  it('opens the first step and folds the rest', async () => {
    const second: ActivityRecord = { ...record, step: 2, headline: '二手目' };
    const html = await render(ExecutionLog({ records: [record, second] }));
    expect(html).toContain('data-execution-step="1"');
    expect(html).toContain('data-execution-step="2"');
    expect((html.match(/data-section-id="request" open=""/g) ?? [])).toHaveLength(1);
    expect((html.match(/data-section-id="request"/g) ?? [])).toHaveLength(2);
  });

  it('sits on the agent page without becoming a timeline', async () => {
    const html = await render(AgentDetailPage({
      agentId: 'agent-a',
      status: {
        agent_status: 'ACTIVE', remaining_seconds: 100, current_task: 'task-1',
        tool_invocations: [], execution_log: [record],
      },
    }));
    expect(html).toContain('data-section="execution-log"');
    expect(html).toContain(record.headline);
    // RULE-59: the status side may show work in flight, and must not look like the
    // timeline, which replays only what has finished.
    expect(html).not.toContain('data-task-id=');
    expect(html).not.toContain('data-status="running"');
  });
});

describe('the written log beside a replay', () => {
  const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => validateActivityEvent({
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: SUBJECT, agent_id: AGENT_ID, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
    title: 'ツールを実行しました', message: '実行し、結果を受け取りました。',
    detail: { event_type: 'TOOL_SUCCEEDED' }, related_finding_id: null, is_simulated: false,
    ...overrides,
  }) as ActivityEvent;

  it('gives every event a numbered entry the animation can point at', async () => {
    const html = await render(EventLog({
      taskId: 'task-1',
      events: [
        { ...event(), record },
        { ...event({ event_id: 'ev-2', outcome: 'blocked', phase: 'security', title: '遮断しました', message: '検知しました。' }) },
      ],
    }));
    expect(html).toContain(EVENT_LOG_CAPTION);
    expect(html).toContain('data-event-log="task-1"');
    expect(html).toContain('data-event-id="ev-1"');
    expect(html).toContain('data-event-id="ev-2"');
    expect(html).toContain('data-emphasis="ev-blocked-security"');
    // The publisher's own sentences, and the breakdown under them.
    expect(html).toContain('実行し、結果を受け取りました。');
    expect(html).toContain(record.headline);
    // The picture and the text call the same box by the same name.
    expect(html).toContain('Agent Runtime');
  });

  it('is rendered by the server, so it reads with no animation at all', async () => {
    const html = await render(TimelinePage({
      tasks: [{
        task_id: 'task-1', agent_id: AGENT_ID, purpose: '日報をまとめる', status: 'completed',
        terminal_outcome: 'success', completed_at: '2026-01-01T00:00:10.000Z',
        events: [{ ...event(), record }],
      }],
    }));
    expect(html).toContain('data-event-log="task-1"');
    expect(html).toContain(record.headline);
    expect(html).toContain('送ったリクエスト');
  });

  it('adds no replay and no log for a task that has not finished', async () => {
    const html = await render(TimelinePage({
      tasks: [{ task_id: 'task-1', agent_id: AGENT_ID, purpose: '実行中の作業', status: 'running' }],
    }));
    expect(html).not.toContain('class="replay"');
    expect(html).not.toContain('data-event-log');
  });
});

describe('the diagram', () => {
  it('captions every box with what it is for', async () => {
    expect(REPLAY_NODES.every((node) => node.role.trim() !== '')).toBe(true);
    const html = await render(ReplayCanvas({ taskId: 'task-1', events: [{ source: 'agent-runtime', record }] }));
    expect(html).toContain('Agent Runtime');
    expect(html).toContain('Agent が動く場所');
    // Explaining the picture is part of the picture, not part of any event.
    for (const line of REPLAY_LEGEND) expect(html).toContain(line);
  });

  it('offers the four controls a person needs to read a step rather than watch it', async () => {
    const html = await render(ReplayCanvas({ taskId: 'task-1', events: [{ source: 'agent-runtime' }] }));
    for (const action of ['replay-play', 'replay-pause', 'replay-step', 'replay-restart']) {
      expect(html).toContain(`data-action="${action}"`);
    }
    expect(html).toContain('data-field="replay-progress"');
    // Still exactly eight boxes, none of them judged before anything has played.
    expect(html.match(/data-reached="false"/g)).toHaveLength(8);
    expect(html).toContain('data-replay-state="idle"');
  });

  /**
   * A tool call passes through the Agent OP and the Resource AS. Reading only the
   * event's own `source` and `target` hid both on exactly the replays that go through
   * them, which is every replay of a call that worked.
   */
  it('shows the boxes the hops passed through, not only the two ends', () => {
    expect(visibleNodeIds([{ source: 'agent-runtime', record }]))
      .toEqual(new Set(['agent-runtime', 'agent-op', 'resource-api']));
  });
});

describe('the plan the canvas plays', () => {
  const nodeIdFor = (source: string): string | null =>
    (REPLAY_NODES.some((node) => node.id === source) ? source : null);

  it('turns one tool call into the exchanges it really made', () => {
    const plan = buildReplayPlan([{
      event_id: 'ev-1', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime',
      phase: 'tool_call', outcome: 'success', message: '実行しました。', record,
    }], nodeIdFor);
    expect(plan.map((step) => [step.from, step.to])).toEqual([
      ['agent-runtime', 'agent-op'],
      ['agent-op', 'agent-runtime'],
      ['agent-runtime', 'resource-api'],
    ]);
    // Every step still belongs to the entry it came from, so the log can follow along.
    expect(plan.every((step) => step.eventId === 'ev-1')).toBe(true);
    expect(plan.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(plan.map((step) => step.delayMs)).toEqual([REPLAY_STEP_MS, REPLAY_STEP_MS, REPLAY_STEP_MS]);
  });

  it('stops the refused hop short and lets the rest arrive', () => {
    const plan = buildReplayPlan([{
      event_id: 'ev-1', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime',
      phase: 'tool_call', outcome: 'blocked', message: '止めました。', record,
    }], nodeIdFor);
    expect(plan.filter((step) => step.blocked)).toHaveLength(1);
    expect(plan[2]).toMatchObject({ blocked: true, to: 'resource-api' });
  });

  it('leaves an event with no hops exactly as it was', () => {
    const plan = buildReplayPlan([{
      event_id: 'ev-1', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime',
      phase: 'tool_call', outcome: 'blocked', message: '止めました。', detail: { target: 'resource-api' },
    }], nodeIdFor);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ from: 'agent-runtime', to: 'resource-api', blocked: true });
  });
});

describe('the replay as a thing a person can stop', () => {
  const document_ = new FakeDocument();

  function canvas(): FakeElement {
    const root = element(document_, 'div', { class: 'replay', 'data-replay-state': 'idle' });
    const svg = element(document_, 'svg');
    for (const node of REPLAY_NODES) {
      svg.appendChild(element(document_, 'g', {
        'data-node': node.id, 'data-reached': 'false', 'data-x': String(node.x), 'data-y': String(node.y),
      }));
    }
    svg.appendChild(element(document_, 'g', { 'data-arrows': 'true' }));
    svg.appendChild(element(document_, 'text', { 'data-banner': 'true' }));
    root.appendChild(svg);
    root.appendChild(element(document_, 'ol', { 'data-messages': 'true' }));
    root.appendChild(element(document_, 'span', { 'data-field': 'replay-progress' }));
    return root;
  }

  function log(...eventIds: string[]): FakeElement {
    const list = element(document_, 'ol', { 'data-event-log': 'task-1' });
    for (const id of eventIds) {
      list.appendChild(element(document_, 'li', { 'data-event-id': id, 'data-entry-state': 'waiting' }));
    }
    return list;
  }

  const events = [
    { event_id: 'ev-1', occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', message: '一番目', detail: { target: 'resource-as' } },
    { event_id: 'ev-2', occurred_at: '2026-01-01T00:01:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', message: '二番目', detail: { target: 'resource-api' } },
  ];

  const states = (list: FakeElement): (string | null)[] =>
    list.children.map((entry) => entry.getAttribute('data-entry-state'));

  it('counts the steps as it goes', () => {
    const root = canvas();
    vi.useFakeTimers();
    try {
      playReplay(root as unknown as HTMLElement, events as never);
      vi.advanceTimersByTime(REPLAY_STEP_MS * 3);
    } finally {
      vi.useRealTimers();
    }
    expect(root.querySelectorAll('[data-field="replay-progress"]')[0]!.textContent).toBe('2 / 2');
    expect(root.getAttribute('data-replay-state')).toBe('finished');
  });

  it('marks the entry it is on, and the ones it has passed', () => {
    const root = canvas();
    const list = log('ev-1', 'ev-2');
    vi.useFakeTimers();
    try {
      const controller = playReplay(root as unknown as HTMLElement, events as never, { log: list as never });
      expect(states(list)).toEqual(['current', 'waiting']);
      controller.pause();
      // Paused after one step, so the boundary between shown and not-shown is visible.
      expect(root.getAttribute('data-replay-state')).toBe('paused');
      vi.advanceTimersByTime(REPLAY_STEP_MS * 5);
      expect(states(list)).toEqual(['current', 'waiting']);

      controller.next();
      expect(states(list)).toEqual(['played', 'current']);
      expect(root.getAttribute('data-replay-state')).toBe('finished');
    } finally {
      vi.useRealTimers();
    }
  });

  it('steps one at a time without ever starting the clock', () => {
    const root = canvas();
    vi.useFakeTimers();
    try {
      const controller = playReplay(root as unknown as HTMLElement, events as never, { autoplay: false } as never);
      expect(root.querySelectorAll('[data-messages]')[0]!.children).toHaveLength(0);
      controller.next();
      expect(root.querySelectorAll('[data-messages]')[0]!.children.map((line) => line.textContent)).toEqual(['一番目']);
      // Nothing is scheduled: a paused replay stays where it was put.
      vi.advanceTimersByTime(REPLAY_STEP_MS * 5);
      expect(root.querySelectorAll('[data-messages]')[0]!.children).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what reaches the browser from the store', () => {
  const stored = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => validateActivityEvent({
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: SUBJECT, agent_id: AGENT_ID, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
    title: 'ツールを実行しました', message: '実行しました。',
    detail: { event_type: 'TASK_COMPLETED' }, related_finding_id: null, is_simulated: false,
    ...overrides,
  }) as ActivityEvent;

  it('carries the record through and leaves the retention stamp behind', async () => {
    const harness = await startAutomationApp();
    await storeActivityEvent({ documents: harness.documents, event: stored({ record }) });
    const [task] = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    const events = (task as { events: ActivityEvent[] }).events;
    expect(events[0]?.record?.headline).toBe(record.headline);
    // `expire_at` is how long the store keeps the row. It is not part of the event and
    // has no business on anyone's screen.
    expect(Object.keys(events[0] ?? {})).not.toContain('expire_at');
    expect(JSON.stringify(events)).not.toContain('expire_at');
  });

  /**
   * The Provisioner's `event_type` is its own step vocabulary and it names the timeline
   * grouping in `activity_kind`. Reading only `event_type` meant `AGENT_PROVISIONED`
   * never matched, so the provisioning of every real agent sat at 実行中 forever.
   */
  it('completes a provisioning task from the vocabulary the Provisioner actually publishes', async () => {
    const harness = await startAutomationApp();
    await storeActivityEvent({
      documents: harness.documents,
      event: stored({
        event_id: 'ev-prov', task_id: 'provisioning', source: 'provisioner', phase: 'provisioning',
        detail: { event_type: 'agent.active', activity_kind: 'AGENT_PROVISIONED', purpose: '日報をまとめる' },
      }),
    });
    const [task] = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    expect(task?.status).toBe('completed');
    // And with a purpose worth heading the group with, rather than the first title.
    expect(task?.purpose).toBe('日報をまとめる');
  });

  it('still leaves a step of provisioning as a step', async () => {
    const harness = await startAutomationApp();
    await storeActivityEvent({
      documents: harness.documents,
      event: stored({
        event_id: 'ev-step', task_id: 'provisioning', source: 'provisioner', phase: 'provisioning',
        detail: { event_type: 'provisioning.started', activity_kind: 'PROVISIONING_STEP' },
      }),
    });
    const [task] = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    expect(task?.status).toBe('running');
  });
});
