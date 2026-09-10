/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { TimelineTask } from '../src/activity/query.js';
import { REPLAY_MOTION_MS, REPLAY_STEP_MS } from '../src/ui/replay/config.js';
import { buildStoryPlan, chapterAt, chapterState } from '../src/ui/replay/story.js';
import { RunCard } from '../src/ui/components/run-card.js';
import { STORY_OPEN_LABEL } from '../src/ui/components/run-player.js';
import { TimelinePage } from '../src/ui/pages/timeline.js';
import { html as render, mount, type Mounted } from './render.js';

const AGENT = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaa';

const stamp = (overrides: Record<string, unknown>) => ({
  trace_id: 'tr', human_subject: 'testuser', agent_id: AGENT, task_id: 'task-1', source: 'agent-runtime', phase: 'tool_call',
  outcome: 'success', title: 't', message: 'm', related_finding_id: null, is_simulated: false, ...overrides,
});

/**
 * One agent's story as the page holds it: the preparation, one piece of work that was
 * refused partway, a piece still running, and the end. Seven steps in three chapters —
 * the tool call in the middle is two exchanges, so one event is two steps.
 */
const tasks = [
  {
    run_id: AGENT, task_id: 'provisioning', agent_id: AGENT, purpose: '日報をまとめる', status: 'completed' as const,
    terminal_outcome: 'success', completed_at: '2026-01-01T00:03:00.000Z',
    events: [
      stamp({
        event_id: 'p1', agent_id: null, task_id: 'provisioning', occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', phase: 'login', outcome: 'info', title: 'ログインしました', message: 'ログイン',
        record: { headline: 'ログインを受け付けました', sections: [{ id: 'received', label: '受け取ったもの', fields: [{ label: 'ログイン先', value: 'Human IdP' }] }] },
      }),
      stamp({ event_id: 'p2', agent_id: null, task_id: 'provisioning', occurred_at: '2026-01-01T00:01:00.000Z', source: 'automation-app', phase: 'authorization', outcome: 'info', title: '権限の決定を求めました', message: '求めた', detail: { target: 'authorization-platform' } }),
      stamp({ event_id: 'p3', task_id: 'provisioning', occurred_at: '2026-01-01T00:03:00.000Z', source: 'provisioner', phase: 'provisioning', outcome: 'success', title: 'Agent が使えるようになりました', message: '作った' }),
    ],
  },
  {
    run_id: AGENT, task_id: 'task-1', agent_id: AGENT, purpose: '日報をまとめる', status: 'completed' as const,
    terminal_outcome: 'blocked', completed_at: '2026-01-01T00:05:00.000Z',
    events: [
      stamp({
        event_id: 't1', occurred_at: '2026-01-01T00:04:00.000Z', title: 'internal.document.list を実行しました', message: '読んだ',
        record: {
          headline: '一覧を読みました',
          sections: [],
          hops: [
            { from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', outcome: 'info', message: '求めた' },
            { from: 'agent-op', to: 'agent-runtime', label: 'ID-JAG を受領', outcome: 'success', message: '受けた' },
          ],
        },
      }),
      stamp({ event_id: 't2', occurred_at: '2026-01-01T00:05:00.000Z', outcome: 'blocked', title: '作業を途中で止めました', message: '許可された Tool に含まれない', detail: { target: 'resource-api' } }),
    ],
  },
  { run_id: AGENT, task_id: 'task-2', agent_id: AGENT, purpose: '日報をまとめる', status: 'running' as const },
  {
    run_id: AGENT, task_id: 'lifecycle', agent_id: AGENT, purpose: '日報をまとめる', status: 'completed' as const,
    terminal_outcome: 'success', completed_at: '2026-01-01T00:06:00.000Z',
    events: [
      stamp({ event_id: 'l1', task_id: 'lifecycle', occurred_at: '2026-01-01T00:06:00.000Z', source: 'automation-app', phase: 'lifecycle', title: 'Agent を停止しました', message: '止めた' }),
    ],
  },
] as unknown as TimelineTask[];

describe('the story plan', () => {
  it('lays the finished tasks end to end, in order, with the running one left out', () => {
    const plan = buildStoryPlan(tasks);
    expect(plan.chapters.map((chapter) => [chapter.taskId, chapter.label, chapter.from, chapter.count])).toEqual([
      ['provisioning', '準備', 0, 3], ['task-1', '作業 1', 3, 3], ['lifecycle', '終了', 6, 1],
    ]);
    // One count across the whole story, and every step knows its chapter and its task.
    expect(plan.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(plan.steps.map((step) => step.chapter)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(plan.steps.map((step) => step.eventId)).toEqual(['p1', 'p2', 'p3', 't1', 't1', 't2', 'l1']);
    expect(plan.steps[3]).toMatchObject({ kind: 'move', from: 'agent-runtime', to: 'agent-op', label: 'ID-JAG を要求', taskKey: `${AGENT}:task-1`, taskId: 'task-1' });
    expect(plan.steps[5]).toMatchObject({ blocked: true, to: 'resource-api' });
    // A chapter's title and outcome are the task's own, as its head prints them.
    expect(plan.chapters.map((chapter) => chapter.title)).toEqual(['Agent が使えるようになりました', '作業を途中で止めました', 'Agent を停止しました']);
    expect(plan.chapters.map((chapter) => chapter.outcome)).toEqual(['success', 'blocked', 'success']);
    expect(plan.events.map((event) => event.event_id)).toEqual(['p1', 'p2', 'p3', 't1', 't2', 'l1']);
  });

  it('keeps every box any chapter involved on the picture', () => {
    const plan = buildStoryPlan(tasks);
    expect([...plan.visible].sort()).toEqual([
      'agent-op', 'agent-provisioner', 'agent-runtime', 'authorization-platform', 'automation-app', 'resource-api',
    ]);
  });

  it('tells which chapter a step is in, and how each chapter stands against it', () => {
    const plan = buildStoryPlan(tasks);
    expect(chapterAt(plan, -1)).toBeNull();
    expect(chapterAt(plan, 0)?.taskId).toBe('provisioning');
    expect(chapterAt(plan, 5)?.taskId).toBe('task-1');
    expect(chapterAt(plan, 6)?.taskId).toBe('lifecycle');
    expect(plan.chapters.map((chapter) => chapterState(chapter, 4))).toEqual(['played', 'current', 'waiting']);
    expect(plan.chapters.map((chapter) => chapterState(chapter, -1))).toEqual(['waiting', 'waiting', 'waiting']);
  });

  it('has no chapter for an agent with nothing finished', () => {
    const plan = buildStoryPlan([tasks[2]!]);
    expect(plan.chapters).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.visible.size).toBe(0);
  });
});

describe('the story as it is served', () => {
  /**
   * The button is on the page a browser is handed; the panel is not. It exists only
   * once a person has pressed for it, so the markup the server renders is the markup
   * the browser's first render produces, and a page without script shows the rail.
   */
  it('offers the button and renders no story picture until it is pressed', () => {
    const html = render(createElement(TimelinePage, { tasks }));
    expect(html).toContain('data-action="story-open"');
    expect(html).toContain(STORY_OPEN_LABEL);
    expect(html).not.toContain('data-story-player');
    expect(html).not.toContain('data-replay-key="story:');
    expect(html).not.toContain('data-story="current"');
    expect(html.match(/data-stage-card=/g)).toHaveLength(3);
  });

  it('offers nothing to play for an agent with no finished task', () => {
    const html = render(createElement(RunCard, {
      run: { runId: 'work:wd_1', agentId: null, purpose: '支払を確認する', tasks: [tasks[2]!] }, open: true, offerFilter: true,
    }));
    expect(html).not.toContain('data-action="story-open"');
    expect(html).toContain('data-status="running"');
  });
});

describe('the story as it plays', () => {
  async function open(): Promise<Mounted> {
    const view = await mount(createElement(TimelinePage, { tasks }));
    await view.click('[data-action="story-open"]');
    return view;
  }
  const panel = (view: Mounted): HTMLElement => view.find('[data-story-player]')!;
  const chapters = (view: Mounted): Array<string | null> => view.all('[data-chapter]').map((li) => li.getAttribute('data-chapter-state'));
  const count = (view: Mounted): string => view.text('[data-story-player] [data-field="caption-step"]');
  const advance = async (view: Mounted, steps: number, stepMs = REPLAY_STEP_MS): Promise<void> => {
    // One step at a time: each step's timer is armed by the effect that runs after the
    // step before it has rendered, so they cannot all be run off in one advance.
    for (let step = 0; step < steps; step += 1) {
      await view.act(async () => { await vi.advanceTimersByTimeAsync(stepMs); });
    }
  };

  /**
   * The whole point: pressed once, the story crosses from the preparation into the
   * work and on to the end by itself, and the rail below follows it. Every string
   * checked on the way is a task's fixed name, a hop's own label or a publisher's own
   * sentence (RULE-54).
   */
  it('opens with every chapter waiting, plays through the seams on its own, and marks the rail as it goes', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      expect(panel(view).getAttribute('data-story-state')).toBe('idle');
      expect(view.find('[data-action="story-open"]')!.getAttribute('aria-pressed')).toBe('true');
      expect(view.all('[data-chapter]').map((li) => [li.getAttribute('data-chapter-task'), li.getAttribute('data-chapter-state')]))
        .toEqual([['provisioning', 'waiting'], ['task-1', 'waiting'], ['lifecycle', 'waiting']]);
      expect(view.find('[data-story-player] [data-replay-key]')!.getAttribute('data-replay-key')).toBe(`story:${AGENT}`);
      // The picture holds every box the story touches, including ones the first
      // chapter never reaches, and hides the ones no chapter does.
      expect(view.find('[data-story-player] [data-node="agent-op"]')!.hasAttribute('hidden')).toBe(false);
      expect(view.find('[data-story-player] [data-node="resource-as"]')!.hasAttribute('hidden')).toBe(true);
      // Nothing plays on its own.
      await advance(view, 2);
      expect(panel(view).getAttribute('data-story-state')).toBe('idle');
      expect(view.all('[data-story]')).toHaveLength(0);

      await view.click('[data-story-player] [data-action="replay-play"]');
      expect(panel(view).getAttribute('data-story-state')).toBe('playing');
      expect(count(view)).toBe('1 / 7');
      expect(view.text('[data-field="story-now-kind"]')).toBe('準備');
      expect(view.text('[data-field="story-now-title"]')).toBe('Agent が使えるようになりました');
      expect(view.text('[data-field="story-now-step"]')).toBe('1 / 3 手目');
      expect(chapters(view)).toEqual(['current', 'waiting', 'waiting']);
      expect(view.find(`[data-stage="${AGENT}:provisioning"]`)!.getAttribute('data-story')).toBe('current');
      expect(view.find('[data-event-id="p1"]')!.getAttribute('data-entry-state')).toBe('current');
      // What the publisher recorded about the step, beside the story's own picture.
      const thinking = `[data-thinking-key="story:${AGENT}"]`;
      expect(view.find(thinking)!.getAttribute('data-thinking-state')).toBe('playing');
      expect(view.text(`${thinking} [data-field="thinking-headline"]`)).toBe('ログインを受け付けました');
      expect(view.find(`${thinking} [data-beat="read"]`)!.textContent).toContain('Human IdP');

      // Three steps later the story has crossed into the work, by itself.
      await advance(view, 3);
      expect(count(view)).toBe('4 / 7');
      expect(view.text('[data-field="story-now-kind"]')).toBe('作業 1');
      expect(view.text('[data-field="story-now-step"]')).toBe('1 / 3 手目');
      expect(chapters(view)).toEqual(['played', 'current', 'waiting']);
      expect(view.find(`[data-stage="${AGENT}:provisioning"]`)!.hasAttribute('data-story')).toBe(false);
      expect(view.find(`[data-stage="${AGENT}:task-1"]`)!.getAttribute('data-story')).toBe('current');
      // The chapter the story has left reads at full strength again: nothing is
      // playing against its list, so none of its rows is dimmed.
      expect(view.find(`[data-log-key="${AGENT}:provisioning"]`)!.getAttribute('data-log-state')).toBe('idle');
      expect(view.find(`[data-log-key="${AGENT}:task-1"]`)!.getAttribute('data-log-state')).toBe('playing');
      expect(view.find('[data-event-id="t1"]')!.getAttribute('data-entry-state')).toBe('current');
      expect(view.find('[data-story-player] .replay')!.getAttribute('data-task-id')).toBe('task-1');
      expect(view.text('[data-story-player] [data-field="caption-label"]')).toBe('ID-JAG を要求');
      expect(view.find(thinking)!.getAttribute('data-thinking-state')).toBe('playing');

      // The refusal stops short, with the publisher's reason under it.
      await advance(view, 2);
      expect(count(view)).toBe('6 / 7');
      expect(view.find('[data-story-player] [data-blocked="true"]')).not.toBeNull();
      expect(view.text('[data-story-player] [data-field="caption-message"]')).toBe('許可された Tool に含まれない');
      expect(view.find('[data-event-id="t2"]')!.getAttribute('data-entry-state')).toBe('current');

      // To the end, where it stays.
      await advance(view, 1);
      expect(panel(view).getAttribute('data-story-state')).toBe('finished');
      expect(count(view)).toBe('7 / 7');
      expect(chapters(view)).toEqual(['played', 'played', 'current']);
      expect(view.find(`[data-stage="${AGENT}:lifecycle"]`)!.getAttribute('data-story')).toBe('current');
      await advance(view, 3);
      expect(count(view)).toBe('7 / 7');
      expect(panel(view).getAttribute('data-story-state')).toBe('finished');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  /** The faster pace: half the step, half the motion, and back again when asked. */
  it('goes twice as fast when asked, and back', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      await view.click('[data-story-player] [data-action="replay-play"]');
      await view.click('[data-action="story-speed"][data-speed="2"]');
      expect(view.find('[data-action="story-speed"][data-speed="2"]')!.getAttribute('aria-pressed')).toBe('true');
      // Half a step at the ordinary pace is a whole step at this one.
      await advance(view, 1, REPLAY_STEP_MS / 2);
      expect(count(view)).toBe('2 / 7');
      expect(view.find('[data-story-player] .replay-dot')!.style.getPropertyValue('--motion-ms')).toBe(`${REPLAY_MOTION_MS / 2}ms`);

      await view.click('[data-action="story-speed"][data-speed="1"]');
      await advance(view, 1, REPLAY_STEP_MS / 2);
      expect(count(view)).toBe('2 / 7');
      await advance(view, 1, REPLAY_STEP_MS / 2);
      expect(count(view)).toBe('3 / 7');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  it('plays from a pressed chapter, moves without playing while paused, and marks nothing once closed', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      await view.click('[data-chapter-task="task-1"] [data-action="story-chapter"]');
      expect(panel(view).getAttribute('data-story-state')).toBe('playing');
      expect(count(view)).toBe('4 / 7');
      expect(view.find('[data-chapter-task="task-1"] [data-action="story-chapter"]')!.getAttribute('aria-current')).toBe('step');
      expect(view.find(`[data-stage="${AGENT}:task-1"]`)!.getAttribute('data-story')).toBe('current');

      await view.click('[data-story-player] [data-action="replay-pause"]');
      await view.click('[data-chapter-task="provisioning"] [data-action="story-chapter"]');
      expect(panel(view).getAttribute('data-story-state')).toBe('paused');
      expect(count(view)).toBe('1 / 7');
      await advance(view, 2);
      expect(count(view)).toBe('1 / 7');
      expect(view.find(`[data-stage="${AGENT}:provisioning"]`)!.getAttribute('data-story')).toBe('current');

      await view.click('[data-action="story-close"]');
      expect(view.find('[data-story-player]')).toBeNull();
      expect(view.all('[data-story]')).toHaveLength(0);
      expect(view.find('[data-action="story-open"]')!.getAttribute('aria-pressed')).toBe('false');
      // Every row of every list reads at full strength again.
      expect(view.all('[data-log-state="playing"]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });
});
