/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { TimelineTask } from '../src/activity/query.js';
import { REPLAY_MOTION_MS, REPLAY_STEP_MS } from '../src/ui/replay/config.js';
import { buildStoryPlan, CAST_CHAPTER_LABEL, chapterAt, chapterOfTask, chapterState, stepOfEvent, stepsOf } from '../src/ui/replay/story.js';
import { RunCard, STORY_OPEN_LABEL } from '../src/ui/components/run-card.js';
import { VIEW_LOG_LABEL, VIEW_REPLAY_LABEL, VIEWER_BACK_LABEL, VIEWER_NOTHING_FINISHED } from '../src/ui/components/activity-viewer.js';
import { REPLAY_CAPTION_IDLE } from '../src/ui/components/replay-canvas.js';
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
 * the tool call in the middle is two exchanges, so one event is two steps — and six
 * boxes, so six introductions before them once the story introduces its cast.
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

/** The boxes the story involves, in the order the dictionary tells the story. */
const CAST = ['automation-app', 'authorization-platform', 'agent-provisioner', 'agent-op', 'agent-runtime', 'resource-api'];

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
    // A chapter's title and outcome are the task's own, as its line prints them.
    expect(plan.chapters.map((chapter) => chapter.title)).toEqual(['Agent が使えるようになりました', '作業を途中で止めました', 'Agent を停止しました']);
    expect(plan.chapters.map((chapter) => chapter.outcome)).toEqual(['success', 'blocked', 'success']);
    expect(plan.events.map((event) => event.event_id)).toEqual(['p1', 'p2', 'p3', 't1', 't2', 'l1']);
    // Not asked to introduce anyone, it introduces no one.
    expect(plan.cast).toEqual([]);
  });

  it('keeps every box any chapter involved on the picture', () => {
    const plan = buildStoryPlan(tasks);
    expect([...plan.visible].sort()).toEqual([...CAST].sort());
  });

  /**
   * The cast, first. One step per box the story involves, in the dictionary's order —
   * the order of the story, not of the diagram — each lighting its box and saying, in
   * the dictionary's own words, what the part is. The story proper follows unchanged,
   * its steps re-numbered after the introductions.
   */
  it('introduces the cast before the first task when asked', () => {
    const plan = buildStoryPlan(tasks, { introduce: true });
    expect(plan.cast.map((actor) => actor.id)).toEqual(CAST);
    expect(plan.chapters[0]).toMatchObject({ kind: 'cast', taskId: 'cast', label: CAST_CHAPTER_LABEL, from: 0, count: 6 });
    expect(plan.chapters.map((chapter) => [chapter.taskId, chapter.from])).toEqual([['cast', 0], ['provisioning', 6], ['task-1', 9], ['lifecycle', 12]]);
    expect(plan.steps).toHaveLength(13);
    expect(plan.steps[0]).toMatchObject({
      kind: 'self', from: 'automation-app', to: null, eventId: 'cast:automation-app', taskKey: '', taskId: 'cast', chapter: 0,
      label: '画面と記録', outcome: 'info', blocked: false,
    });
    expect(plan.steps[0]!.cast).toMatchObject({ id: 'automation-app', analogy: '受付' });
    expect(plan.steps[0]!.message).toBe(plan.steps[0]!.cast!.does);
    expect(plan.steps.slice(6).map((step) => step.eventId)).toEqual(['p1', 'p2', 'p3', 't1', 't1', 't2', 'l1']);
    expect(plan.steps.slice(6).map((step) => step.index)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(plan.steps.slice(6).every((step) => step.cast === undefined)).toBe(true);
    expect(plan.events).toHaveLength(6);
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

  /** What an address names — a task, an event — found in the plan, so the viewer can open on it. */
  it('finds a chapter by its task and a step by its event', () => {
    const plan = buildStoryPlan(tasks, { introduce: true });
    expect(chapterOfTask(plan, 'task-1')?.from).toBe(9);
    expect(chapterOfTask(plan, 'cast')).toBeNull();
    expect(chapterOfTask(plan, 'task-2')).toBeNull();
    // An event of several exchanges is found at its first.
    expect(stepOfEvent(plan, 't1')?.index).toBe(9);
    expect(stepOfEvent(plan, 't2')?.index).toBe(11);
    expect(stepOfEvent(plan, 'nowhere')).toBeNull();
    expect(stepsOf(plan, plan.chapters[2]!).map((step) => step.eventId)).toEqual(['t1', 't1', 't2']);
  });

  it('has no chapter, and no one to introduce, for an agent with nothing finished', () => {
    const plan = buildStoryPlan([tasks[2]!], { introduce: true });
    expect(plan.chapters).toEqual([]);
    expect(plan.steps).toEqual([]);
    expect(plan.cast).toEqual([]);
    expect(plan.visible.size).toBe(0);
  });
});

describe('the story as it is served', () => {
  /**
   * The list offers the door and nothing behind it: the viewer is another address,
   * which the server renders when asked for it, so the list a browser is handed carries
   * no picture, no roster and no account — only lines, and the addresses they lead to.
   */
  it('offers the story as an address on the list, and renders no picture there', () => {
    const html = render(createElement(TimelinePage, { tasks }));
    expect(html).toContain(STORY_OPEN_LABEL);
    expect(html).toContain(`data-action="story-open" href="/activity?run=${AGENT}&amp;view=replay"`);
    expect(html).not.toContain('data-story-player');
    expect(html).not.toContain('data-replay-key');
    expect(html).not.toContain('data-cast-roster');
    expect(html).not.toContain('data-event-log');
    expect(html.match(/data-stage-card=/g)).toHaveLength(3);
  });

  it('offers nothing to play for an agent with no finished task', () => {
    const html = render(createElement(RunCard, {
      run: { runId: 'work:wd_1', agentId: null, purpose: '支払を確認する', tasks: [tasks[2]!] }, offerFilter: true,
    }));
    expect(html).not.toContain('data-action="story-open"');
    expect(html).toContain('data-status="running"');
    const viewer = render(createElement(TimelinePage, {
      tasks: [tasks[2]!], focus: { runId: AGENT, taskId: null, view: 'replay', eventId: null },
    }));
    expect(viewer).toContain(VIEWER_NOTHING_FINISHED);
    expect(viewer).not.toContain('class="replay"');
  });

  /**
   * The viewer stands where the address says, rendered whole by the server: the
   * picture idle on the chapter a person opened, or paused on the very event they were
   * sent to; the account on the event they chose, with its record beside the lines. A
   * person without script reads all of it, and follows its links to the rest.
   */
  it('stands where the address says, on either face', () => {
    const picture = render(createElement(TimelinePage, { tasks, focus: { runId: AGENT, taskId: 'task-1', view: 'replay', eventId: null } }));
    expect(picture).toContain('data-story-player');
    expect(picture).toContain('data-viewer-mode="replay"');
    expect(picture).toContain('data-story-state="idle"');
    expect(picture).toMatch(/data-chapter-task="task-1"[^>]*data-chapter-state="current"/);
    expect(picture).toContain(REPLAY_CAPTION_IDLE);
    expect(picture).not.toContain('data-event-log');
    expect(picture).not.toContain('data-caption-notes');

    const step = render(createElement(TimelinePage, { tasks, focus: { runId: AGENT, taskId: 'task-1', view: 'replay', eventId: 't2' } }));
    expect(step).toContain('data-story-state="paused"');
    expect(step).toContain('data-replay-state="paused"');
    expect(step).toContain('data-caption-state="blocked"');
    expect(step).toMatch(/data-field="caption-message"[^>]*>許可された Tool に含まれない</);

    const account = render(createElement(TimelinePage, { tasks, focus: { runId: AGENT, taskId: 'task-1', view: 'log', eventId: 't2' } }));
    expect(account).toContain('data-viewer-mode="log"');
    expect(account).toContain(`data-log-key="${AGENT}:task-1"`);
    expect(account).toContain('data-event-detail="t2"');
    expect(account).toMatch(/href="\/activity\?run=[^"]*&amp;event=t2" data-action="select-event" aria-current="true"/);
    expect(account).not.toContain('class="replay"');
    // An account with no event named opens on the chapter's first.
    const first = render(createElement(TimelinePage, { tasks, focus: { runId: AGENT, taskId: 'task-1', view: 'log', eventId: null } }));
    expect(first).toContain('data-event-detail="t1"');
    expect(first).toContain('一覧を読みました');
  });

  it('links every chapter, face and line, and comes back to the list it was opened from', () => {
    const html = render(createElement(TimelinePage, { tasks, agentId: AGENT, focus: { runId: AGENT, taskId: 'task-1', view: 'log', eventId: null } }));
    expect(html).toContain(`href="/activity?agent_id=${AGENT}" data-action="viewer-close"`);
    expect(html).toContain(VIEWER_BACK_LABEL);
    expect(html).toContain(`href="/activity?agent_id=${AGENT}&amp;run=${AGENT}&amp;task=task-1&amp;view=replay" class="" data-action="viewer-mode" data-mode="replay"`);
    expect(html).toContain(VIEW_REPLAY_LABEL);
    expect(html).toContain(VIEW_LOG_LABEL);
    for (const taskId of ['provisioning', 'task-1', 'lifecycle']) {
      expect(html).toContain(`href="/activity?agent_id=${AGENT}&amp;run=${AGENT}&amp;task=${taskId}&amp;view=log" data-action="story-chapter"`);
    }
    // The running task is on the strip, named, and leads nowhere yet.
    expect(html).toMatch(/data-chapter-task="task-2" data-chapter-state="running"/);
    expect(html).not.toMatch(/data-chapter-task="task-2"[^>]*>\s*<a/);
  });
});

describe('the story as it plays', () => {
  async function open(): Promise<Mounted> {
    return mount(createElement(TimelinePage, { tasks, focus: { runId: AGENT, taskId: null, view: 'replay', eventId: null } }));
  }
  const panel = (view: Mounted): HTMLElement => view.find('[data-story-player]')!;
  const canvas = (view: Mounted): HTMLElement => view.find('[data-story-player] .replay')!;
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
   * Who is who, before anyone moves. Pressing 再生 introduces the cast — each box lit
   * alone, named and likened under itself on the picture, its part and what it does
   * not do written under the picture inside the frame. Every string is the
   * dictionary's (RULE-54).
   */
  it('opens on the cast, introduces each part in turn, and only then starts the story', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      expect(panel(view).getAttribute('data-story-state')).toBe('idle');
      // The chapter the viewer opened on is the one marked, before anything plays.
      expect(view.all('[data-chapter]').map((li) => [li.getAttribute('data-chapter-task'), li.getAttribute('data-chapter-state')]))
        .toEqual([['cast', 'current'], ['provisioning', 'waiting'], ['task-1', 'waiting'], ['lifecycle', 'waiting'], ['task-2', 'running']]);
      // Before anything plays, the frame says only what pressing 再生 does.
      expect(view.text('[data-field="caption-message"]')).toBe(REPLAY_CAPTION_IDLE);
      expect(view.all('[data-caption]')).toHaveLength(1);
      // The introduction chapter is a chapter with no outcome: nothing happened in it.
      expect(view.find('[data-chapter-task="cast"] .badge')).toBeNull();
      // Nothing plays on its own.
      await advance(view, 2);
      expect(panel(view).getAttribute('data-story-state')).toBe('idle');

      await view.click('[data-story-player] [data-action="replay-play"]');
      expect(count(view)).toBe('1 / 6');
      expect(chapters(view)).toEqual(['current', 'waiting', 'waiting', 'waiting', 'running']);
      // The picture: the one box lit alone, named and likened under itself.
      expect(canvas(view).getAttribute('data-replay-mode')).toBe('cast');
      expect(view.find('[data-story-player] [data-node="automation-app"]')!.getAttribute('data-active')).toBe('self');
      expect(view.text('[data-story-player] [data-callout="automation-app"]')).toContain('ToDo の画面（受付）');
      expect(view.text('[data-story-player] [data-callout="automation-app"]')).toContain('画面と記録');
      expect(view.all('[data-story-player] [data-arrows] path')).toHaveLength(0);
      // The words under the picture, inside its frame: the part's name, its phrase,
      // what it does and what it does not do — and nothing anywhere else.
      expect(view.text('[data-story-player] [data-field="caption-route"]')).toBe('ToDo の画面');
      expect(view.text('[data-story-player] [data-field="caption-label"]')).toBe('画面と記録');
      expect(view.text('[data-story-player] [data-field="caption-message"]')).toContain('いま見ているこの画面');
      expect(view.text('[data-story-player] [data-field="caption-does-not"]')).toContain('権限を決めない');
      expect(view.find('[data-replay-frame] [data-caption]')).not.toBeNull();
      expect(view.all('[data-caption]')).toHaveLength(1);
      expect(view.find('[data-caption-notes]')).toBeNull();

      await advance(view, 1);
      expect(view.text('[data-story-player] [data-callout="authorization-platform"]')).toContain('権限決定（審査係）');
      expect(view.text('[data-story-player] [data-field="caption-route"]')).toBe('権限決定');

      // Five more, and the story proper begins, counted from the chapter's own first step.
      await advance(view, 5);
      expect(count(view)).toBe('1 / 3');
      expect(chapters(view)).toEqual(['played', 'current', 'waiting', 'waiting', 'running']);
      expect(canvas(view).getAttribute('data-replay-mode')).toBe('story');
      expect(view.find('[data-story-player] [data-callout]')).toBeNull();
      expect(view.find('[data-field="caption-does-not"]')).toBeNull();
      // A login says only its own sentence: its record holds no words of the agent's and no checks.
      expect(view.text('[data-story-player] [data-field="caption-message"]')).toBe('ログイン');
      expect(view.find('[data-caption-notes]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  /**
   * The whole point: pressed once, the story crosses from the preparation into the
   * work and on to the end by itself. Every string checked on the way is a task's
   * fixed name, a hop's own label or a publisher's own sentence (RULE-54).
   */
  it('plays through the seams on its own, and draws each call as one journey', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      expect(view.find('[data-story-player] [data-replay-key]')!.getAttribute('data-replay-key')).toBe(`story:${AGENT}`);
      // The picture holds every box the story touches, including ones the first
      // chapter never reaches, and hides the ones no chapter does — bands with them.
      expect(view.find('[data-story-player] [data-node="agent-op"]')!.hasAttribute('hidden')).toBe(false);
      expect(view.find('[data-story-player] [data-node="resource-as"]')!.hasAttribute('hidden')).toBe(true);
      expect(view.find('[data-story-player] [data-lane="person"]')!.hasAttribute('hidden')).toBe(true);
      expect(view.find('[data-story-player] [data-lane="control"]')!.hasAttribute('hidden')).toBe(false);

      await view.click('[data-chapter-task="provisioning"] [data-action="story-chapter"]');
      expect(panel(view).getAttribute('data-story-state')).toBe('playing');
      expect(count(view)).toBe('1 / 3');
      expect(view.text('[data-field="replay-progress"]')).toBe('1 / 3');

      // Three steps later the story has crossed into the work, by itself.
      await advance(view, 3);
      expect(count(view)).toBe('1 / 3');
      expect(chapters(view)).toEqual(['played', 'played', 'current', 'waiting', 'running']);
      expect(canvas(view).getAttribute('data-task-id')).toBe('task-1');
      expect(view.text('[data-story-player] [data-field="caption-label"]')).toBe('ID-JAG を要求');
      // The first leg of a call: a line with a head, and no trail yet.
      expect(view.find('[data-story-player] [data-arrowhead]')).not.toBeNull();
      expect(view.all('[data-story-player] [data-trail] path')).toHaveLength(0);

      // The second leg keeps the first faintly on the picture: one call, two legs.
      await advance(view, 1);
      expect(count(view)).toBe('2 / 3');
      expect(view.text('[data-story-player] [data-field="caption-label"]')).toBe('ID-JAG を受領');
      expect(view.all('[data-story-player] [data-trail] path')).toHaveLength(1);

      // The refusal: a new event, so the trail is gone; the line stops short, the rest
      // is dotted, there is no head, and the publisher's reason is under it.
      await advance(view, 1);
      expect(count(view)).toBe('3 / 3');
      expect(view.all('[data-story-player] [data-trail] path')).toHaveLength(0);
      expect(view.find('[data-story-player] [data-blocked="true"]')).not.toBeNull();
      expect(view.find('[data-story-player] [data-unreached-path]')).not.toBeNull();
      expect(view.find('[data-story-player] [data-arrowhead]')).toBeNull();
      expect(view.text('[data-story-player] [data-field="caption-message"]')).toBe('許可された Tool に含まれない');

      // To the end, where it stays.
      await advance(view, 1);
      expect(panel(view).getAttribute('data-story-state')).toBe('finished');
      expect(count(view)).toBe('1 / 1');
      expect(chapters(view)).toEqual(['played', 'played', 'played', 'current', 'running']);
      await advance(view, 3);
      expect(count(view)).toBe('1 / 1');
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
      await view.click('[data-chapter-task="provisioning"] [data-action="story-chapter"]');
      expect(count(view)).toBe('1 / 3');
      await view.click('[data-action="story-speed"][data-speed="2"]');
      expect(view.find('[data-action="story-speed"][data-speed="2"]')!.getAttribute('aria-pressed')).toBe('true');
      // Half a step at the ordinary pace is a whole step at this one.
      await advance(view, 1, REPLAY_STEP_MS / 2);
      expect(count(view)).toBe('2 / 3');
      // And the dot, the line and the words move for half as long, so they land before the step is up.
      expect(view.find('[data-story-player] .replay-dot')!.style.getPropertyValue('--motion-ms')).toBe(`${REPLAY_MOTION_MS / 2}ms`);
      expect(view.find('[data-story-player] [data-arrows] .is-live')!.style.getPropertyValue('--motion-ms')).toBe(`${REPLAY_MOTION_MS / 2}ms`);

      await view.click('[data-action="story-speed"][data-speed="1"]');
      await advance(view, 1, REPLAY_STEP_MS / 2);
      expect(count(view)).toBe('2 / 3');
      await advance(view, 1, REPLAY_STEP_MS / 2);
      expect(count(view)).toBe('3 / 3');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  it('plays from a pressed chapter, and moves without playing while paused', async () => {
    vi.useFakeTimers();
    const view = await open();
    try {
      await view.click('[data-chapter-task="task-1"] [data-action="story-chapter"]');
      expect(panel(view).getAttribute('data-story-state')).toBe('playing');
      expect(count(view)).toBe('1 / 3');
      expect(view.find('[data-chapter-task="task-1"] [data-action="story-chapter"]')!.getAttribute('aria-current')).toBe('step');

      await view.click('[data-story-player] [data-action="replay-pause"]');
      await view.click('[data-chapter-task="provisioning"] [data-action="story-chapter"]');
      expect(panel(view).getAttribute('data-story-state')).toBe('paused');
      expect(count(view)).toBe('1 / 3');
      expect(view.text('[data-story-player] [data-field="caption-message"]')).toBe('ログイン');
      await advance(view, 2);
      expect(count(view)).toBe('1 / 3');
      expect(view.find('[data-chapter-task="provisioning"] [data-action="story-chapter"]')!.getAttribute('aria-current')).toBe('step');

      // 最初から: this chapter's own start, playing; the story's start is the first chapter, one press away.
      await view.click('[data-story-player] [data-action="replay-step"]');
      expect(count(view)).toBe('2 / 3');
      await view.click('[data-story-player] [data-action="replay-restart"]');
      expect(count(view)).toBe('1 / 3');
      expect(panel(view).getAttribute('data-story-state')).toBe('playing');
    } finally {
      vi.useRealTimers();
    }
    await view.unmount();
  });

  /**
   * The account: one chapter's lines, one record beside them, and one face at a time.
   * The introduction chapter is walked the same way, its parts as lines and a part's
   * card as its record.
   */
  it('shows one task\'s lines and one record at a time on the account, and walks the cast the same way', async () => {
    const view = await mount(createElement(TimelinePage, { tasks, focus: { runId: AGENT, taskId: 'task-1', view: 'log', eventId: null } }));
    expect(view.find('main')!.getAttribute('data-viewer-mode')).toBe('log');
    expect(view.find('.replay')).toBeNull();
    expect(view.all('[data-event-log]')).toHaveLength(1);
    expect(view.all('[data-event-id]').map((row) => [row.getAttribute('data-event-id'), row.getAttribute('data-entry-state')]))
      .toEqual([['t1', 'current'], ['t2', 'waiting']]);
    expect(view.all('[data-event-detail]').map((detail) => detail.getAttribute('data-event-detail'))).toEqual(['t1']);
    expect(view.text('[data-event-detail="t1"] [data-field="record-headline"]')).toBe('一覧を読みました');
    // The record beside the lines says the route the picture would draw, standing still.
    expect(view.find('[data-event-detail="t1"] [data-route-strip]')).not.toBeNull();

    await view.click('[data-event-id="t2"] [data-action="select-event"]');
    expect(view.all('[data-event-detail]').map((detail) => detail.getAttribute('data-event-detail'))).toEqual(['t2']);
    expect(view.text('[data-event-detail="t2"] [data-field="event-message"]')).toBe('許可された Tool に含まれない');
    expect(view.find('[data-event-id="t1"]')!.getAttribute('data-entry-state')).toBe('played');

    // Another chapter: its lines replace these, and its first record is showing.
    await view.click('[data-chapter-task="provisioning"] [data-action="story-chapter"]');
    expect(view.find('main')!.getAttribute('data-story-state')).toBe('paused');
    expect(view.all('[data-event-id]').map((row) => row.getAttribute('data-event-id'))).toEqual(['p1', 'p2', 'p3']);
    expect(view.all('[data-event-detail]').map((detail) => detail.getAttribute('data-event-detail'))).toEqual(['p1']);

    // The cast, as lines and cards.
    await view.click('[data-chapter-task="cast"] [data-action="story-chapter"]');
    expect(view.find('[data-event-log]')).toBeNull();
    expect(view.all('[data-cast-row]').map((row) => row.getAttribute('data-cast-row'))).toEqual(CAST);
    expect(view.find('[data-cast-row="automation-app"]')!.getAttribute('data-entry-state')).toBe('current');
    expect(view.find('[data-cast-detail="automation-app"] [data-field="role-does-not"]')!.textContent).toContain('権限を決めない');
    await view.click('[data-cast-row="agent-provisioner"] [data-action="select-cast"]');
    expect(view.all('[data-cast-detail]').map((detail) => detail.getAttribute('data-cast-detail'))).toEqual(['agent-provisioner']);
    await view.unmount();
  });
});
