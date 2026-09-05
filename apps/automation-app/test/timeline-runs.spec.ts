import { describe, expect, it, vi } from 'vitest';
import {
  drainActivityQueueForTesting, resetActivityPublisherForTesting, validateActivityEvent, type ActivityEvent,
} from '@xaa/contracts';
import { capabilitiesHash } from '../src/agent-definition/approval.js';
import { storeActivityEvent } from '../src/activity/subscriber.js';
import { readTimeline, taskKeyOf } from '../src/activity/query.js';
import { NO_AGENT_YET } from '../src/ui/components/agent-group.js';
import { RecordView, HOPS_CAPTION } from '../src/ui/components/record-view.js';
import { ReplayCanvas, REPLAY_CAPTION_IDLE } from '../src/ui/components/replay-canvas.js';
import { TimelinePage } from '../src/ui/pages/timeline.js';
import { REPLAY_NODES, SOURCE_TO_NODE } from '../src/ui/replay/nodes.js';
import { buildReplayPlan } from '../../automation-app/client/src/replay-plan.js';
import { playReplay, showLocalTimes } from '../../automation-app/client/src/replay.js';
import { REPLAY_STEP_MS } from '../../automation-app/client/src/replay-config.js';
import { FakeDocument, FakeElement, element } from './fake-dom.js';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp, type Harness } from './helpers.js';

const render = async (node: unknown): Promise<string> => String(await node);
const AGENT_B = 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb';

let counter = 0;
function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  counter += 1;
  return validateActivityEvent({
    event_id: `ev-${counter}`, trace_id: 'tr', human_subject: SUBJECT, agent_id: null, task_id: 'provisioning',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', phase: 'work_definition', outcome: 'info',
    title: 't', message: 'm', related_finding_id: null, is_simulated: false, ...overrides,
  }) as ActivityEvent;
}

const at = (minute: number): string => `2026-01-01T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;

/** One agent's whole story, from the login before it to the end of its first task. */
function story(input: { agent: string; work: string; decision: string; from: number; purpose: string }): ActivityEvent[] {
  const { agent, work, decision, from, purpose } = input;
  return [
    event({ occurred_at: at(from), phase: 'login', detail: { event_type: 'LOGGED_IN' } }),
    event({ occurred_at: at(from + 1), detail: { event_type: 'PROPOSED', work_definition_id: work, purpose } }),
    event({ occurred_at: at(from + 2), outcome: 'success', detail: { event_type: 'CONFIRMED', work_definition_id: work, purpose } }),
    event({ occurred_at: at(from + 3), phase: 'authorization', detail: { event_type: 'DECISION_REQUESTED', work_definition_id: work, purpose } }),
    event({ occurred_at: at(from + 4), source: 'authorization', phase: 'authorization', detail: { event_type: 'CAPABILITY_DECIDED', decision_id: decision } }),
    event({ occurred_at: at(from + 4), source: 'authorization', phase: 'authorization', detail: { event_type: 'ISOLATION_DECIDED', decision_id: decision } }),
    event({ occurred_at: at(from + 5), phase: 'authorization', detail: { event_type: 'DECISION_RECEIVED', work_definition_id: work, decision_id: decision, purpose } }),
    event({ occurred_at: at(from + 6), phase: 'provisioning', detail: { event_type: 'PROVISION_REQUESTED', work_definition_id: work, decision_id: decision, purpose } }),
    event({ occurred_at: at(from + 7), agent_id: agent, source: 'provisioner', phase: 'provisioning', detail: { event_type: 'provisioning.started', activity_kind: 'PROVISIONING_STEP', decision_id: decision } }),
    event({ occurred_at: at(from + 8), agent_id: agent, source: 'provisioner', phase: 'provisioning', outcome: 'success', detail: { event_type: 'agent.active', activity_kind: 'AGENT_PROVISIONED' } }),
    event({ occurred_at: at(from + 9), agent_id: agent, task_id: 'task-1', detail: { event_type: 'INSTRUCTION_ADDED', decision_id: decision, work_definition_id: work } }),
    event({ occurred_at: at(from + 10), agent_id: agent, task_id: 'task-1', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', detail: { event_type: 'TOOL_SUCCEEDED', tool_id: 'internal.document.list' } }),
    event({ occurred_at: at(from + 11), agent_id: agent, task_id: 'task-1', source: 'agent-runtime', phase: 'tool_call', outcome: 'success', detail: { event_type: 'TASK_COMPLETED' } }),
  ];
}

async function seed(harness: Harness, events: readonly ActivityEvent[]): Promise<void> {
  // Stored out of order on purpose: the reader decides the order, not the store.
  for (const entry of [...events].reverse()) await storeActivityEvent({ documents: harness.documents, event: entry });
}

/**
 * The chronology bug. Every agent has a `provisioning`, a `task-1` and a `lifecycle`,
 * and grouping by `task_id` alone merged two agents into one: the second login landed
 * inside the first agent's provisioning, after that agent was already active, and the
 * second agent's `task-1` played as a continuation of the first's.
 */
describe('one agent, one story', () => {
  it('keeps two agents apart, from the login that preceded each to the end of its task', async () => {
    const harness = await startAutomationApp();
    const first = story({ agent: AGENT_ID, work: 'wd_a', decision: 'dec_a', from: 0, purpose: '日報をまとめる' });
    const second = story({ agent: AGENT_B, work: 'wd_b', decision: 'dec_b', from: 60, purpose: '経費を集計する' });
    await seed(harness, [...first, ...second]);

    const tasks = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    // Newest agent first; within an agent, provisioning then the task.
    expect(tasks.map((task) => [task.run_id, task.task_id])).toEqual([
      [AGENT_B, 'provisioning'], [AGENT_B, 'task-1'],
      [AGENT_ID, 'provisioning'], [AGENT_ID, 'task-1'],
    ]);
    expect(tasks.map((task) => task.purpose)).toEqual(['経費を集計する', '経費を集計する', '日報をまとめる', '日報をまとめる']);
    expect(tasks.every((task) => task.status === 'completed')).toBe(true);

    // The first agent's provisioning is exactly its own ten events, login first, agent
    // active last — and nothing of the second agent's, which happened an hour later.
    const provisioning = tasks[2] as Extract<typeof tasks[number], { status: 'completed' }>;
    expect(provisioning.agent_id).toBe(AGENT_ID);
    expect(provisioning.events.map((entry) => (entry.detail as { event_type: string }).event_type)).toEqual([
      'LOGGED_IN', 'PROPOSED', 'CONFIRMED', 'DECISION_REQUESTED', 'CAPABILITY_DECIDED', 'ISOLATION_DECIDED',
      'DECISION_RECEIVED', 'PROVISION_REQUESTED', 'provisioning.started', 'agent.active',
    ]);
    expect(provisioning.events.every((entry) => entry.occurred_at < at(60))).toBe(true);
    // The second login is the first line of the second agent's story.
    const later = tasks[0] as Extract<typeof tasks[number], { status: 'completed' }>;
    expect(later.events[0]?.occurred_at).toBe(at(60));
    expect((later.events[0]?.detail as { event_type: string }).event_type).toBe('LOGGED_IN');
    // Each agent's task-1 holds only that agent's work.
    for (const [index, agent] of [[1, AGENT_B], [3, AGENT_ID]] as const) {
      const task = tasks[index] as Extract<typeof tasks[number], { status: 'completed' }>;
      expect(task.events.every((entry) => entry.agent_id === agent)).toBe(true);
      expect(task.events).toHaveLength(3);
    }
  });

  it('shows work that has been decided but not yet provisioned as a run of its own', async () => {
    const harness = await startAutomationApp();
    await seed(harness, [
      event({ occurred_at: at(0), phase: 'login', detail: { event_type: 'LOGGED_IN' } }),
      event({ occurred_at: at(1), detail: { event_type: 'PROPOSED', work_definition_id: 'wd_c', purpose: '支払を確認する' } }),
      event({ occurred_at: at(2), source: 'authorization', phase: 'authorization', detail: { event_type: 'CAPABILITY_DECIDED', decision_id: 'dec_c' } }),
      event({ occurred_at: at(3), phase: 'authorization', detail: { event_type: 'DECISION_RECEIVED', work_definition_id: 'wd_c', decision_id: 'dec_c', purpose: '支払を確認する' } }),
    ]);
    const tasks = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ run_id: 'decision:dec_c', agent_id: null, purpose: '支払を確認する', status: 'running' });

    const html = await render(TimelinePage({ tasks }));
    expect(html).toContain(NO_AGENT_YET);
    expect(html).toContain('data-run-id="decision:dec_c"');
  });

  it('leaves a login that led to no work out of every story', async () => {
    const harness = await startAutomationApp();
    await seed(harness, [
      ...story({ agent: AGENT_ID, work: 'wd_a', decision: 'dec_a', from: 0, purpose: '日報' }),
      event({ occurred_at: at(200), phase: 'login', detail: { event_type: 'LOGGED_IN' } }),
    ]);
    const tasks = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    expect(tasks).toHaveLength(2);
    const all = tasks.flatMap((task) => (task.status === 'completed' ? task.events : []));
    expect(all.filter((entry) => entry.occurred_at === at(200))).toHaveLength(0);
  });

  it('names a replacement agent after the work of the one it replaced', async () => {
    const harness = await startAutomationApp();
    await seed(harness, [
      ...story({ agent: AGENT_ID, work: 'wd_a', decision: 'dec_a', from: 0, purpose: '日報をまとめる' }),
      event({ occurred_at: at(30), agent_id: AGENT_B, source: 'provisioner', phase: 'provisioning', detail: { event_type: 'provisioning.started', activity_kind: 'PROVISIONING_STEP', replaces_agent_id: AGENT_ID } }),
      event({ occurred_at: at(31), agent_id: AGENT_B, source: 'provisioner', phase: 'provisioning', outcome: 'success', detail: { event_type: 'agent.active', activity_kind: 'AGENT_PROVISIONED' } }),
    ]);
    const tasks = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    expect(tasks[0]).toMatchObject({ run_id: AGENT_B, purpose: '日報をまとめる', status: 'completed' });
  });

  it('keys each canvas and log by agent and task together', async () => {
    const harness = await startAutomationApp();
    await seed(harness, [
      ...story({ agent: AGENT_ID, work: 'wd_a', decision: 'dec_a', from: 0, purpose: 'A' }),
      ...story({ agent: AGENT_B, work: 'wd_b', decision: 'dec_b', from: 60, purpose: 'B' }),
    ]);
    const tasks = await readTimeline({ documents: harness.documents, humanSubject: SUBJECT });
    const html = await render(TimelinePage({ tasks }));
    for (const task of tasks) {
      expect(html).toContain(`data-replay-key="${taskKeyOf(task)}"`);
      expect(html).toContain(`data-log-key="${taskKeyOf(task)}"`);
      expect(html).toContain(`data-task-key="${taskKeyOf(task)}"`);
    }
    // Two agents, two `task-1` rows, and the keys tell them apart.
    expect(html.match(new RegExp(`data-task-key="${AGENT_ID}:task-1"`, 'g'))).toHaveLength(1);
    expect(html.match(new RegExp(`data-task-key="${AGENT_B}:task-1"`, 'g'))).toHaveLength(1);
    expect(taskKeyOf({ run_id: AGENT_ID, task_id: 'task-1' })).not.toBe(taskKeyOf({ run_id: AGENT_B, task_id: 'task-1' }));

    const body = await (await harness.fetch('/api/activity/tasks')).json() as { tasks: Array<{ run_id: string }> };
    expect(body.tasks.map((task) => task.run_id)).toEqual([AGENT_B, AGENT_B, AGENT_ID, AGENT_ID]);
  });
});

/**
 * The events this app publishes about its own steps — asking the Authorization
 * Platform, receiving the decision, the approval, the provisioning request, the first
 * instruction — each carrying the ids the timeline joins on and the hops the picture
 * draws. Through the routes, so a route that stops emitting is what fails.
 */
describe('what the Automation App says about its own steps', () => {
  const eventTypes = (): string[] => drainActivityQueueForTesting()
    .map((entry) => (entry.detail as { event_type: string }).event_type);

  async function seedConfirmedWork(harness: Harness): Promise<void> {
    await harness.documents.set('work_definitions', 'wd_1', {
      work_definition_id: 'wd_1', human_subject: SUBJECT, status: 'CONFIRMED',
      purpose: '経費の申請書を読む', description: '毎朝9時に確認する',
      operations: ['申請書の一覧を開く'], user_confirmations: [], safety_notes: ['承認はしない'],
      requested_lifetime_minutes: 180, created_at: at(0), updated_at: at(0),
    });
  }

  it('records the ask and the answer around a decision', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => Response.json({
        decision_id: 'dec_1', status: 'decided', effective_capabilities: ['x.read'],
        denied: [{ capability_id: 'x.write', decision: 'DENY', reason_code: 'not_delegatable', policy_id: 'del-1' }],
        security_profile: { risk_score: 0, isolation_level: 'standard', reasons: [] },
      }),
    });
    await seedConfirmedWork(harness);
    resetActivityPublisherForTesting();

    expect((await harness.fetch('/api/work-definitions/wd_1/submit', { method: 'POST' })).status).toBe(200);

    const published = drainActivityQueueForTesting();
    expect(published.map((entry) => (entry.detail as { event_type: string }).event_type))
      .toEqual(['DECISION_REQUESTED', 'DECISION_RECEIVED']);
    const [asked, answered] = published as [ActivityEvent, ActivityEvent];
    expect(asked.detail).toMatchObject({ work_definition_id: 'wd_1', target: 'authorization-platform' });
    expect(asked.record?.hops).toEqual([expect.objectContaining({ from: 'automation-app', to: 'authorization-platform' })]);
    // The join: the work this app knows, and the decision the Authorization Platform names.
    expect(answered.detail).toMatchObject({ work_definition_id: 'wd_1', decision_id: 'dec_1' });
    expect(answered.record?.hops).toEqual([expect.objectContaining({ from: 'authorization-platform', to: 'automation-app' })]);
    // Values as they arrived, nothing said about them.
    const received = answered.record?.sections.find((section) => section.id === 'received');
    expect(received?.fields).toContainEqual({ label: '許可された操作', value: 'x.read' });
    expect(received?.fields).toContainEqual({ label: '却下された操作の数', value: '1 件' });
    for (const entry of published) expect(() => validateActivityEvent(entry)).not.toThrow();
  });

  it('records a decision that was refused, as a movement that did not arrive', async () => {
    const harness = await startAutomationApp({ upstreamHandler: () => Response.json({ error: 'invalid_request' }, { status: 400 }) });
    await seedConfirmedWork(harness);
    resetActivityPublisherForTesting();
    await harness.fetch('/api/work-definitions/wd_1/submit', { method: 'POST' });
    const published = drainActivityQueueForTesting();
    expect(published.map((entry) => (entry.detail as { event_type: string }).event_type)).toEqual(['DECISION_REQUESTED', 'DECISION_REFUSED']);
    expect(published[1]).toMatchObject({ outcome: 'blocked' });
    expect(published[1]?.record?.hops?.[0]).toMatchObject({ to: 'authorization-platform', outcome: 'blocked' });
  });

  it('records the approval, the provisioning request and the first instruction', async () => {
    const harness = await startAutomationApp({
      upstreamHandler: () => Response.json({ status: 'PROVISIONED', agent_id: AGENT_ID, task_id: 'task-1' }, { status: 201 }),
    });
    await seedConfirmedWork(harness);
    await harness.documents.set('agent_definitions', 'ad_1', {
      agent_definition_id: 'ad_1', human_subject: SUBJECT, work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['x.read'], presented_capabilities_hash: await capabilitiesHash(['x.read']),
      isolation_level: 'standard', approved_by: null, approved_at: null, created_at: at(0),
    });
    await harness.authorizationSeed.set('authorization_decisions', 'dec_1', { effective_capabilities: ['x.read'] });
    await seedAgent(harness);
    resetActivityPublisherForTesting();

    expect((await harness.fetch('/api/agent-definitions/ad_1/approve', { method: 'POST' })).status).toBe(200);
    expect(eventTypes()).toEqual(['AGENT_DEFINITION_APPROVED']);

    expect((await harness.fetch('/api/agent-definitions/ad_1/provision', { method: 'POST' })).status).toBe(201);
    const published = drainActivityQueueForTesting();
    expect(published.map((entry) => (entry.detail as { event_type: string }).event_type))
      .toEqual(['PROVISION_REQUESTED', 'INSTRUCTION_ADDED']);
    expect(published[0]?.record?.hops?.[0]).toMatchObject({ from: 'automation-app', to: 'agent-provisioner' });
    // The first instruction is filed under the agent's first task and carries the ids
    // that join the agent to its decision and its work.
    expect(published[1]).toMatchObject({ agent_id: AGENT_ID, task_id: 'task-1' });
    expect(published[1]?.detail).toMatchObject({ initial: true, decision_id: 'dec_1', work_definition_id: 'wd_1' });
    expect(published[1]?.record?.sections[0]?.text).toContain('経費の申請書を読む');
    expect(published[1]?.record?.sections[0]?.format).toBe('text');
  });

  it('files a later instruction under the task the agent is on', async () => {
    const harness = await startAutomationApp();
    await seedAgent(harness, { state: { agent_status: 'ACTIVE', task_context: { task_id: 'task-3' } } });
    resetActivityPublisherForTesting();
    const response = await harness.fetch(`/api/agents/${AGENT_ID}/instructions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '未払いの請求書も見て' }),
    });
    expect(response.status).toBe(201);
    const [added] = drainActivityQueueForTesting();
    expect(added).toMatchObject({ agent_id: AGENT_ID, task_id: 'task-3' });
    expect(added?.detail).toMatchObject({ event_type: 'INSTRUCTION_ADDED', initial: false });
    expect(added?.record?.hops?.map((hop) => [hop.from, hop.to])).toEqual([
      ['human-user', 'automation-app'], ['automation-app', 'agent-runtime'],
    ]);
  });

  /**
   * The consent return trip. The Provisioner echoes `task-1`, not a work definition id,
   * so the work had to be found another way — through the transaction the definition
   * remembered when the consent screen took the request away. Without this, an agent
   * created through a consent screen was never told its work.
   */
  it('tells an agent created through a consent screen what it was made for', async () => {
    let call = 0;
    const harness = await startAutomationApp({
      upstreamHandler: () => {
        call += 1;
        return call === 1
          ? Response.json({ status: 'IDP_CONSENT_REQUIRED', transaction_id: 'txn-9', consent_url: 'https://human-idp.test/consent' }, { status: 200 })
          : Response.json({ status: 'PROVISIONED', transaction_id: 'txn-9', agent_id: AGENT_ID, task_id: 'task-1' }, { status: 201 });
      },
    });
    await seedConfirmedWork(harness);
    await harness.documents.set('agent_definitions', 'ad_1', {
      agent_definition_id: 'ad_1', human_subject: SUBJECT, work_definition_id: 'wd_1', decision_id: 'dec_1',
      presented_capabilities: ['x.read'], presented_capabilities_hash: await capabilitiesHash(['x.read']),
      isolation_level: 'standard', approved_by: SUBJECT, approved_at: at(1), created_at: at(0),
    });
    await harness.authorizationSeed.set('authorization_decisions', 'dec_1', { effective_capabilities: ['x.read'] });
    await seedAgent(harness);

    const first = await harness.fetch('/api/agent-definitions/ad_1/provision', { method: 'POST' });
    expect(await first.json()).toMatchObject({ consent_url: 'https://human-idp.test/consent' });
    resetActivityPublisherForTesting();

    const back = await harness.fetch('/provisioning/resume?transaction_id=txn-9&code=one-time', { redirect: 'manual' });
    expect(back.headers.get('location')).toBe(`/agents/${AGENT_ID}`);
    const stored = await harness.documents.queryEqual<{ text: string }>('agent_instructions', [['agent_id', AGENT_ID]]);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data.text).toContain('経費の申請書を読む');
    const [added] = drainActivityQueueForTesting();
    expect(added?.detail).toMatchObject({ event_type: 'INSTRUCTION_ADDED', initial: true, decision_id: 'dec_1' });
    expect(harness.logLines.join('\n')).not.toContain('work_definition_not_found');
  });
});

describe('what the record panel shows in the open', () => {
  it('shows prose as a quotation and folds a body', async () => {
    const html = await render(RecordView({
      record: {
        headline: 'h',
        sections: [
          { id: 'intent', label: 'エージェントが決めたこと', message: '1 手目です。', text: 'まず一覧を取ります。', format: 'text', fields: [{ label: '選んだツール', value: 'internal.document.list' }] },
          { id: 'request', label: '送ったリクエスト', text: '{"limit":10}', format: 'json' },
        ],
        hops: [{ from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: '身元を求めました。' }],
      },
    }));
    const outsideDisclosures = html.split(/<details[\s\S]*?<\/details>/g).join('');
    expect(outsideDisclosures).toContain('まず一覧を取ります。');
    expect(outsideDisclosures).toContain('data-prose="true"');
    expect(outsideDisclosures).not.toContain('{&quot;limit&quot;:10}');
    // The route, listed under the record in the diagram's own names, folded.
    expect(html).toContain(HOPS_CAPTION);
    expect(html).toContain('data-hop-outcome="info"');
    expect(html).toContain('Agent Runtime');
    expect(html).toContain('Agent OP');
    expect(html).toContain('ID-JAG を要求');
  });
});

describe('the plan with words on it', () => {
  const nodeIdFor = (source: string): string | null => SOURCE_TO_NODE[source] ?? null;

  it('lights the box for an event that moved nothing, instead of inventing an arrow', () => {
    const plan = buildReplayPlan([
      { event_id: 'a', occurred_at: at(0), source: 'automation-app', outcome: 'info', title: '作業を書いた', message: '一', detail: { target: 'authorization-platform' } },
      { event_id: 'b', occurred_at: at(1), source: 'authorization', outcome: 'info', title: '権限を決定しました', message: '二' },
      { event_id: 'c', occurred_at: at(2), source: 'security-detection', outcome: 'blocked', title: '検知', message: '三' },
    ], nodeIdFor);
    expect(plan.map((step) => step.kind)).toEqual(['move', 'self', 'banner']);
    expect(plan[1]).toMatchObject({ from: 'authorization-platform', to: null, label: '権限を決定しました' });
    expect(plan.map((step) => step.label)).toEqual(['作業を書いた', '権限を決定しました', '検知']);
  });

  it('names each hop by its own label', () => {
    const plan = buildReplayPlan([{
      event_id: 'a', occurred_at: at(0), source: 'agent-runtime', outcome: 'success', message: 'm',
      record: { hops: [
        { from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: '求めた' },
        { from: 'agent-op', to: 'agent-runtime', label: 'ID-JAG を受領', outcome: 'success', message: '受けた' },
      ] },
    }], nodeIdFor);
    expect(plan.map((step) => [step.kind, step.label])).toEqual([['move', 'ID-JAG を要求'], ['move', 'ID-JAG を受領']]);
  });
});

describe('the replay as it speaks', () => {
  const document_ = new FakeDocument();

  function canvas(): FakeElement {
    const root = element(document_, 'div', { class: 'replay', 'data-replay-state': 'idle' });
    const svg = element(document_, 'svg');
    svg.appendChild(element(document_, 'g', { 'data-arrows': 'true' }));
    for (const node of REPLAY_NODES) {
      svg.appendChild(element(document_, 'g', {
        'data-node': node.id, 'data-reached': 'false', 'data-active': '', 'data-x': String(node.x), 'data-y': String(node.y),
      }));
    }
    svg.appendChild(element(document_, 'g', { 'data-labels': 'true' }));
    svg.appendChild(element(document_, 'g', { 'data-dots': 'true' }));
    svg.appendChild(element(document_, 'text', { 'data-banner': 'true' }));
    root.appendChild(svg);
    const caption = element(document_, 'div', { 'data-caption': 'true', 'data-caption-state': 'idle' });
    for (const field of ['caption-step', 'caption-route', 'caption-label', 'caption-message']) {
      caption.appendChild(element(document_, 'span', { 'data-field': field }));
    }
    root.appendChild(caption);
    root.appendChild(element(document_, 'ol', { 'data-messages': 'true' }));
    return root;
  }

  function play(root: FakeElement, events: unknown[]): void {
    vi.useFakeTimers();
    try {
      playReplay(root as unknown as HTMLElement, events as never);
      vi.advanceTimersByTime(REPLAY_STEP_MS * (events.length + 2));
    } finally {
      vi.useRealTimers();
    }
  }

  const field = (root: FakeElement, name: string): string => root.querySelectorAll(`[data-field="${name}"]`)[0]!.textContent;

  it('writes the route, the exchange and the sentence under the picture, and on the arrow', () => {
    const root = canvas();
    play(root, [{
      event_id: 'a', occurred_at: at(0), source: 'agent-runtime', phase: 'tool_call', outcome: 'success', message: 'm',
      record: { hops: [{ from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: 'Agent OP に身元を求めました。' }] },
    }]);
    expect(field(root, 'caption-step')).toBe('1 / 1');
    expect(field(root, 'caption-route')).toBe('Agent Runtime → Agent OP');
    expect(field(root, 'caption-label')).toBe('ID-JAG を要求');
    expect(field(root, 'caption-message')).toBe('Agent OP に身元を求めました。');
    expect(root.querySelectorAll('[data-caption]')[0]!.getAttribute('data-caption-state')).toBe('playing');
    const labels = root.querySelectorAll('[data-arrow-label]');
    expect(labels).toHaveLength(1);
    expect(labels[0]!.textContent).toBe('ID-JAG を要求');
    // The two boxes involved are lit, told apart, and nothing else is.
    const lit = root.querySelectorAll('[data-node]').filter((node) => node.getAttribute('data-active') !== '');
    expect(lit.map((node) => [node.getAttribute('data-node'), node.getAttribute('data-active')]))
      .toEqual([['agent-op', 'to'], ['agent-runtime', 'from']]);
  });

  it('pulses the box for a step that stayed inside it', () => {
    const root = canvas();
    play(root, [{ event_id: 'a', occurred_at: at(0), source: 'authorization', phase: 'authorization', outcome: 'info', title: '権限を決定しました', message: '許可：x' }]);
    expect(root.querySelectorAll('[data-pulse="true"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-arrow-label]')).toHaveLength(0);
    expect(field(root, 'caption-route')).toBe('Authorization Platform');
    expect(field(root, 'caption-label')).toBe('権限を決定しました');
    const box = root.querySelectorAll('[data-node="authorization-platform"]')[0]!;
    expect(box.getAttribute('data-active')).toBe('self');
    expect(box.getAttribute('data-reached')).toBe('true');
  });

  it('serves the caption empty and explains what will appear there', async () => {
    const html = await render(ReplayCanvas({ taskId: 'task-1', taskKey: 'agent-a:task-1', events: [{ source: 'agent-runtime' }] }));
    expect(html).toContain('data-caption="true"');
    expect(html).toContain('data-caption-state="idle"');
    expect(html).toContain(REPLAY_CAPTION_IDLE);
    expect(html).toContain('data-labels="true"');
    expect(html).toContain('data-replay-key="agent-a:task-1"');
  });
});

describe('the recorded instants in the reader\'s clock', () => {
  it('rewrites the text, keeps the recorded value, and leaves a bad one alone', () => {
    const document_ = new FakeDocument();
    const root = element(document_, 'div');
    const good = element(document_, 'time', { datetime: '2026-01-01T00:00:00.000Z' });
    good.textContent = '2026-01-01T00:00:00.000Z';
    const bad = element(document_, 'time', { datetime: 'not a time' });
    bad.textContent = 'not a time';
    root.appendChild(good);
    root.appendChild(bad);
    showLocalTimes(root as never);
    expect(good.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
    expect(good.getAttribute('title')).toBe('2026-01-01T00:00:00.000Z');
    expect(good.textContent).not.toBe('2026-01-01T00:00:00.000Z');
    expect(good.textContent).toMatch(/2026/);
    expect(bad.textContent).toBe('not a time');
  });
});
