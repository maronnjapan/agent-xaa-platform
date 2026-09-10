import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineTask } from '../../activity/query.js';
import { taskKeyOf } from '../../activity/task-key.js';
import { activityFocusPath, activityListPath, type ActivityFocus, type ActivityView } from '../activity-links.js';
import { taskLabelOf } from '../labels.js';
import { REPLAY_MOTION_MS, REPLAY_STEP_MS } from '../replay/config.js';
import { buildFrame } from '../replay/geometry.js';
import { trailOf } from '../replay/plan.js';
import {
  buildStoryPlan, chapterAt, chapterOfTask, chapterState, stepOfEvent, stepsOf, type StoryChapter, type StoryPlan, type StoryStep,
} from '../replay/story.js';
import { thinkingByEvent, type ThinkingFrame } from '../replay/thinking.js';
import { roleOf, type ActorRole } from '../roles.js';
import { CastRoster, CastSpotlight, RoleCard } from './cast-panel.js';
import { EventDetail } from './event-detail.js';
import { EventLog, toLogEvent } from './event-log.js';
import { OutcomeBadge } from './outcome-badge.js';
import { ReplayCanvas, type ReplayControls } from './replay-canvas.js';
import { NO_PURPOSE, type Run } from './run-card.js';
import { SimulatedBadge } from './simulated-badge.js';
import { TASK_RUNNING_LABEL } from './task-row.js';
import { ThinkingPanel } from './thinking-panel.js';
import type { Element } from '../element.js';

/** Screen furniture: what the viewer and its controls are called. None of it is about an event (RULE-54). */
export const VIEWER_BACK_LABEL = 'アクティビティの一覧へ戻る';
export const VIEW_REPLAY_LABEL = '動きを図で見る';
export const VIEW_LOG_LABEL = 'できごとを読む';
export const VIEWER_NOTHING_FINISHED = '終わった区切りがまだありません。区切りが終わると、ここで再生できます。';
export const STORY_SPEED_LABEL = '速さ';
export const STORY_FULLSCREEN_LABEL = '全画面で見る';
export const STORY_FULLSCREEN_EXIT_LABEL = '全画面をやめる';
export const STORY_CHAPTERS_LABEL = '区切り';
export const CAST_LOG_NOTE = '図に出てくるものです。名前を押すと、その説明が出ます。';

/**
 * How fast the story goes, as a factor over the ordinary pace.
 *
 * The ordinary step is long enough to read the caption and the reasoning beside it
 * (docs 11 §5.2). A person showing the story to a room is talking over it rather than
 * reading it, and for them the same step is a wait — so the viewer offers one faster
 * pace, and nothing faster than that: at more than twice the speed the dot no longer
 * reads as a movement from one box to another.
 */
export const STORY_SPEEDS = [
  { factor: 1, label: 'ふつう' },
  { factor: 2, label: '速く' },
] as const;

export type StorySpeed = (typeof STORY_SPEEDS)[number]['factor'];

type ReplayState = 'idle' | 'playing' | 'paused' | 'finished';

/** Nothing has played yet. Distinct from step 0, which has. */
const NOTHING_PLAYED = -1;

/** Where the viewer stands: which chapter, which step of the story, and whether it is moving. */
interface Position {
  /** The chapter the viewer is on; the chapter of `index` whenever a step has been reached. */
  at: number;
  /** The step the story is on, or -1 before anything has been reached. */
  index: number;
  state: ReplayState;
}

/**
 * Where the viewer opens, from the address.
 *
 * An address that names an event opens on that event's first step, standing still; the
 * account opens on the chapter's first event, because an account with no event chosen
 * has nothing to show beside its list; and the picture opens waiting, with the chapter
 * marked and nothing played — nothing plays until a person presses for it.
 */
function openingPosition(plan: StoryPlan, focus: ActivityFocus): Position {
  const byTask = focus.taskId === null ? null : chapterOfTask(plan, focus.taskId);
  const byEvent = focus.eventId === null ? null : stepOfEvent(plan, focus.eventId);
  if (byEvent && (byTask === null || byEvent.chapter === byTask.index)) {
    return { at: byEvent.chapter, index: byEvent.index, state: 'paused' };
  }
  const chapter = byTask ?? plan.chapters[0];
  if (!chapter) return { at: 0, index: NOTHING_PLAYED, state: 'idle' };
  if (focus.view === 'log') return { at: chapter.index, index: chapter.from, state: 'paused' };
  return { at: chapter.index, index: NOTHING_PLAYED, state: 'idle' };
}

/**
 * One agent, one screen, one thing on it.
 *
 * The list showed an agent's tasks each opened into a picture and a written account,
 * side by side, task after task, with the whole story's player above them all — and a
 * person looking at it could not tell what to follow. This is the other way round: the
 * viewer takes the screen for one agent, and shows one of two faces at a time. 動きを図
 * で見る is the picture: the diagram, its controls, the sentence for the step, and
 * beside it who is who or what the agent was thinking — briefly. できごとを読む is the
 * account: one task's events as lines down the left, and the whole record of the one
 * line that is chosen on the right. Nothing else is on the screen.
 *
 * The two faces share one state — where the story stands — so switching between them
 * keeps the place. The step the picture is on is the event the account has chosen;
 * choosing another line in the account moves the picture to that event, standing
 * still. The chapters over both are the finished tasks in the order they happened,
 * and a pressed chapter moves the story to its first step.
 *
 * It is the same data as the list, and it is not a demo screen: nothing about it is
 * different when the story is a demonstration, except that a scripted chapter carries
 * its label wherever it is named (RULE-58). Nothing plays on its own, and nothing
 * loops (docs 11 §5.2). The server renders the face the address names, with the
 * story standing where the address says, so a person without script reads the account
 * of any event by following its link; a person with script gets the same page and the
 * buttons.
 *
 * The picture can be taken to the whole screen, which is what a projector wants; the
 * request goes to the browser and nothing is decided from its answer, so a browser
 * without the ability simply keeps the page where it is.
 */
export function ActivityViewer(props: { run: Run; focus: ActivityFocus; agentId?: string | null }): Element {
  const { run, focus } = props;
  const agentId = props.agentId ?? null;
  const plan = useMemo(() => buildStoryPlan(run.tasks, { introduce: true }), [run.tasks]);
  const thinking = useMemo(() => thinkingByEvent(plan.events), [plan]);
  const tasksByKey = useMemo(() => new Map(run.tasks.map((task) => [taskKeyOf(task), task])), [run.tasks]);

  const [mode, setMode] = useState<ActivityView>(focus.view);
  const [position, setPosition] = useState<Position>(() => openingPosition(plan, focus));
  const [speed, setSpeed] = useState<StorySpeed>(1);
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const panel = useRef<HTMLElement>(null);

  const { at, index, state } = position;
  const last = plan.steps.length - 1;
  const chapter: StoryChapter | null = chapterAt(plan, index) ?? plan.chapters[at] ?? null;
  const step: StoryStep | undefined = index >= 0 ? plan.steps[index] : undefined;

  /** Moves the story to a step; whether it then keeps going is the caller's to say. */
  const settle = useCallback((next: number, playing: boolean): void => {
    const target = chapterAt(plan, next);
    setPosition({
      at: target ? target.index : 0,
      index: next,
      state: next >= last ? 'finished' : (playing ? 'playing' : 'paused'),
    });
  }, [plan, last]);

  /*
   * One timer per step, re-armed after each step has rendered — never an interval. The
   * length is the ordinary step divided by the chosen pace, so changing the pace
   * mid-story re-arms the current step at the new length rather than waiting out the
   * old one.
   */
  useEffect(() => {
    if (state !== 'playing') return undefined;
    const timer = setTimeout(() => settle(index + 1, true), REPLAY_STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [state, index, speed, settle]);

  const controls: ReplayControls = useMemo(() => ({
    play: () => { if (state !== 'finished' && chapter) settle(index >= 0 ? index : chapter.from, true); },
    pause: () => setPosition((current) => (current.state === 'playing' ? { ...current, state: 'paused' } : current)),
    next: () => { if (state !== 'finished' && chapter) settle(index >= 0 ? Math.min(index + 1, last) : chapter.from, false); },
    // From the start of the chapter the viewer is on: the story's own start is the first chapter, one press away.
    restart: () => { if (chapter) settle(chapter.from, true); },
  }), [state, index, last, chapter, settle]);

  /*
   * A chapter is pressed to be watched from, so on the picture it starts playing unless
   * the person had deliberately paused — a paused story stays paused and merely moves.
   * On the account it only moves: the account never plays.
   */
  const jumpTo = useCallback((target: StoryChapter): void => {
    settle(target.from, mode === 'replay' && state !== 'paused');
  }, [settle, mode, state]);

  /*
   * The account needs an event to show, so entering it with nothing reached stands on
   * the chapter's first; and a story that kept playing behind the account would be
   * moving where nobody could see it, so entering it pauses.
   */
  const switchTo = useCallback((view: ActivityView): void => {
    setMode(view);
    if (view === 'log' && index < 0 && chapter) settle(chapter.from, false);
    if (view === 'log' && state === 'playing') setPosition((current) => ({ ...current, state: 'paused' }));
  }, [index, chapter, state, settle]);

  const selectEvent = useCallback((eventId: string): void => {
    const target = stepOfEvent(plan, eventId);
    if (target) settle(target.index, false);
  }, [plan, settle]);

  /* The address follows the viewer, so a reload or a shared link lands on the same face, chapter and event. */
  const currentEventId = step && !step.cast ? step.eventId : null;
  const chapterTaskId = chapter && chapter.kind !== 'cast' ? chapter.taskId : null;
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
    const href = activityFocusPath({ runId: run.runId, taskId: chapterTaskId, view: mode, eventId: mode === 'log' ? currentEventId : null }, agentId);
    window.history.replaceState(null, '', href);
  }, [run.runId, chapterTaskId, mode, currentEventId, agentId]);

  /* Whether this screen is the thing on the whole display, read back from the browser rather than assumed. */
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const sync = (): void => setFullscreen(panel.current !== null && document.fullscreenElement === panel.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullscreen = (): void => {
    const element = panel.current;
    if (!element || typeof document === 'undefined') return;
    if (document.fullscreenElement === element) {
      if (typeof document.exitFullscreen === 'function') Promise.resolve(document.exitFullscreen()).catch(() => undefined);
      return;
    }
    if (typeof element.requestFullscreen !== 'function') return;
    Promise.resolve(element.requestFullscreen()).catch(() => undefined);
  };

  const hrefOf = (view: ActivityView, taskId: string | null, eventId: string | null): string =>
    activityFocusPath({ runId: run.runId, taskId, view, eventId }, agentId);
  const storyKey = `story:${run.runId}`;
  const simulated = run.tasks.some((task) => task.status === 'completed' && task.events.some((event) => event.is_simulated === true));

  return (
    <main
      ref={panel}
      className="timeline viewer"
      data-page="timeline"
      data-viewer={run.runId}
      data-viewer-mode={mode}
      data-story-player={run.runId}
      data-story-state={state}
      data-story-fullscreen={String(fullscreen)}
    >
      <header className="viewer-head">
        <p className="viewer-back">
          <a href={activityListPath(agentId)} data-action="viewer-close">{VIEWER_BACK_LABEL}</a>
        </p>
        <div className="viewer-title">
          <h1 className="viewer-purpose" data-field="run-purpose">{run.purpose === '' ? NO_PURPOSE : run.purpose}</h1>
          {simulated ? <span className="chip chip-demo" data-chip="demo">デモ実行（模擬）</span> : null}
        </div>
        <nav className="view-switch viewer-modes" aria-label="見せ方">
          <a
            href={hrefOf('replay', chapterTaskId, null)}
            className={mode === 'replay' ? 'is-selected' : ''}
            data-action="viewer-mode"
            data-mode="replay"
            {...(mode === 'replay' ? { 'aria-current': 'page' as const } : {})}
            onClick={(press) => { press.preventDefault(); switchTo('replay'); }}
          >
            {VIEW_REPLAY_LABEL}
          </a>
          <a
            href={hrefOf('log', chapterTaskId, currentEventId)}
            className={mode === 'log' ? 'is-selected' : ''}
            data-action="viewer-mode"
            data-mode="log"
            {...(mode === 'log' ? { 'aria-current': 'page' as const } : {})}
            onClick={(press) => { press.preventDefault(); switchTo('log'); }}
          >
            {VIEW_LOG_LABEL}
          </a>
        </nav>
      </header>

      {plan.chapters.length === 0
        ? <p className="timeline-empty" data-field="viewer-empty">{VIEWER_NOTHING_FINISHED}</p>
        : (
          <>
            <ol className="story-chapters" data-story-chapters="true" aria-label={STORY_CHAPTERS_LABEL}>
              {plan.chapters.map((entry) => (
                <li
                  key={entry.taskKey}
                  data-chapter={entry.taskKey}
                  data-chapter-task={entry.taskId}
                  data-chapter-kind={entry.kind}
                  data-chapter-state={index >= 0 ? chapterState(entry, index) : (entry.index === at ? 'current' : 'waiting')}
                >
                  <a
                    href={hrefOf(mode, entry.kind === 'cast' ? null : entry.taskId, null)}
                    data-action="story-chapter"
                    {...(chapter?.index === entry.index ? { 'aria-current': 'step' as const } : {})}
                    onClick={(press) => { press.preventDefault(); jumpTo(entry); }}
                  >
                    <span className="chapter-kind">{entry.label}</span>
                    <span className="chapter-meta">
                      {entry.simulated ? <SimulatedBadge position="row" /> : null}
                      {entry.kind === 'cast' ? null : <OutcomeBadge outcome={entry.outcome} phase={entry.phase} />}
                    </span>
                  </a>
                </li>
              ))}
              {run.tasks.filter((task) => task.status === 'running').map((task) => (
                <li key={taskKeyOf(task)} data-chapter={taskKeyOf(task)} data-chapter-task={task.task_id} data-chapter-state="running">
                  <span className="chapter-running">
                    <span className="chapter-kind">{taskLabelOf(task.task_id).label}</span>
                    <span className="badge ev-running">{TASK_RUNNING_LABEL}</span>
                  </span>
                </li>
              ))}
            </ol>

            {/*
              * Which chapter the viewer is in, and — on the picture — how far through it.
              * Keyed by the chapter, so a new chapter is a new line and the stylesheet can
              * slide it in: the seam between two tasks is seen as well as counted. Both
              * strings are the chapter's fixed name and its publisher's title.
              */}
            {chapter
              ? (
                <p key={chapter.taskKey} className="story-now" data-field="story-now">
                  <span className="story-now-kind" data-field="story-now-kind">{chapter.label}</span>
                  <span className="story-now-title" data-field="story-now-title">{chapter.title}</span>
                  {mode === 'replay' && step
                    ? <span className="story-now-step" data-field="story-now-step">{`${index - chapter.from + 1} / ${chapter.count} 手目`}</span>
                    : null}
                </p>
              )
              : null}

            {mode === 'replay' && chapter
              ? (
                <ReplayFace
                  plan={plan}
                  chapter={chapter}
                  step={step}
                  index={index}
                  state={state}
                  speed={speed}
                  storyKey={storyKey}
                  thinkingOf={(eventId) => thinking.get(eventId) ?? null}
                  controls={controls}
                  fullscreen={fullscreen}
                  openNode={openNode}
                  onOpenNode={setOpenNode}
                  onSpeed={setSpeed}
                  onFullscreen={toggleFullscreen}
                  readMoreHref={currentEventId === null ? null : hrefOf('log', chapterTaskId, currentEventId)}
                  onReadMore={() => switchTo('log')}
                />
              )
              : null}

            {mode === 'log' && chapter
              ? (
                <LogFace
                  plan={plan}
                  chapter={chapter}
                  step={step}
                  task={tasksByKey.get(chapter.taskKey) ?? null}
                  hrefOf={(eventId) => hrefOf('log', chapterTaskId, eventId)}
                  onSelect={selectEvent}
                  onSelectStep={(target) => settle(target, false)}
                />
              )
              : null}
          </>
        )}
    </main>
  );
}

/**
 * The picture: the diagram with its controls and its caption, and beside it one of
 * three things — the cast before anything plays, the part being introduced while the
 * introduction plays, what the agent was thinking once the story proper is on — or the
 * description of a box the person pressed. One place, one answer at a time.
 */
function ReplayFace(props: {
  plan: StoryPlan;
  chapter: StoryChapter;
  step: StoryStep | undefined;
  index: number;
  state: ReplayState;
  speed: StorySpeed;
  storyKey: string;
  thinkingOf: (eventId: string) => ThinkingFrame | null;
  controls: ReplayControls;
  fullscreen: boolean;
  openNode: string | null;
  onOpenNode: (id: string | null) => void;
  onSpeed: (speed: StorySpeed) => void;
  onFullscreen: () => void;
  readMoreHref: string | null;
  onReadMore: () => void;
}): Element {
  const { plan, chapter, step, index, state } = props;
  const frame = step ? buildFrame(step, plan.visible) : null;
  const trail = useMemo(
    () => (index >= 0 ? trailOf(plan.steps, index).map((earlier) => buildFrame(earlier, plan.visible)) : []),
    [plan, index],
  );
  const opened: ActorRole | null = props.openNode === null ? null : roleOf(props.openNode);
  const currentEventId = step && !step.cast ? step.eventId : null;

  const tools = (
    <>
      <span className="story-speed" role="group" aria-label={STORY_SPEED_LABEL}>
        <span className="story-speed-label">{STORY_SPEED_LABEL}</span>
        {STORY_SPEEDS.map((option) => (
          <button
            key={option.factor}
            type="button"
            className={props.speed === option.factor ? 'is-selected' : ''}
            data-action="story-speed"
            data-speed={String(option.factor)}
            aria-pressed={props.speed === option.factor}
            onClick={() => props.onSpeed(option.factor)}
          >
            {option.label}
          </button>
        ))}
      </span>
      <button type="button" className="secondary" data-action="story-fullscreen" onClick={props.onFullscreen}>
        {props.fullscreen ? STORY_FULLSCREEN_EXIT_LABEL : STORY_FULLSCREEN_LABEL}
      </button>
    </>
  );

  return (
    <div className="viewer-stage" data-viewer-stage="true">
      <ReplayCanvas
        taskId={chapter.taskId}
        taskKey={props.storyKey}
        visible={plan.visible}
        simulated={chapter.simulated}
        state={state}
        frame={frame}
        trail={trail}
        total={plan.steps.length}
        position={step ? { at: index - chapter.from + 1, of: chapter.count } : null}
        controls={props.controls}
        motionMs={REPLAY_MOTION_MS / props.speed}
        openNode={props.openNode}
        onOpenNode={props.onOpenNode}
        tools={tools}
      />
      <div className="viewer-aside">
        {opened
          ? (
            <div className="replay-role-open" data-role-open={opened.id}>
              <RoleCard actor={opened} />
              <button type="button" className="secondary" data-action="close-role" onClick={() => props.onOpenNode(null)}>閉じる</button>
            </div>
          )
          : step?.cast
            ? <CastSpotlight actor={step.cast} position={`${index - chapter.from + 1} / ${chapter.count}`} />
            : state === 'idle' && plan.cast.length > 0
              ? <CastRoster actors={plan.cast} />
              : (
                <ThinkingPanel
                  taskKey={props.storyKey}
                  frame={currentEventId === null ? null : props.thinkingOf(currentEventId)}
                  {...(props.readMoreHref ? { readMoreHref: props.readMoreHref } : {})}
                  onReadMore={props.onReadMore}
                />
              )}
      </div>
    </div>
  );
}

/**
 * The account: one chapter's events as lines, and the whole record of the chosen one.
 * The introduction chapter has no events; its lines are the parts of the story, and
 * the record of a chosen part is its card.
 */
function LogFace(props: {
  plan: StoryPlan;
  chapter: StoryChapter;
  step: StoryStep | undefined;
  task: TimelineTask | null;
  hrefOf: (eventId: string | null) => string;
  onSelect: (eventId: string) => void;
  onSelectStep: (index: number) => void;
}): Element {
  const { plan, chapter, step } = props;
  if (chapter.kind === 'cast') {
    const steps = stepsOf(plan, chapter);
    const chosen = step?.cast ?? null;
    return (
      <div className="viewer-log" data-viewer-log={chapter.taskKey}>
        <section className="event-log" data-cast-log="true">
          <p className="event-log-note">{CAST_LOG_NOTE}</p>
          <ol className="event-list">
            {steps.map((entry, order) => (
              <li
                key={entry.eventId}
                className="event-entry"
                data-cast-row={entry.cast?.id ?? ''}
                data-entry-state={chosen?.id === entry.cast?.id ? 'current' : 'waiting'}
              >
                <span className="event-rail" data-role-lane={entry.cast?.lane ?? ''} aria-hidden="true" />
                <a
                  className="event-row"
                  href={props.hrefOf(null)}
                  data-action="select-cast"
                  onClick={(press) => { press.preventDefault(); props.onSelectStep(entry.index); }}
                >
                  <span className="event-order">{String(order + 1)}</span>
                  <span className="event-line">
                    <span className="event-title">{entry.cast?.name ?? entry.label}</span>
                    <span className="event-head">
                      <span className="roster-analogy">{entry.cast?.analogy ?? ''}</span>
                      <span className="event-source-role">{entry.label}</span>
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </section>
        {chosen ? <div className="event-detail" data-cast-detail={chosen.id}><RoleCard actor={chosen} /></div> : null}
      </div>
    );
  }

  const task = props.task;
  const events = task && task.status === 'completed' ? task.events.map(toLogEvent) : [];
  const chosenIndex = step ? events.findIndex((event) => event.event_id === step.eventId) : -1;
  const chosen = chosenIndex >= 0 ? events[chosenIndex] : undefined;
  return (
    <div className="viewer-log" data-viewer-log={chapter.taskKey}>
      <EventLog
        taskId={chapter.taskId}
        taskKey={chapter.taskKey}
        events={events}
        currentEventId={chosen?.event_id ?? null}
        hrefFor={(event) => props.hrefOf(event.event_id)}
        onSelect={props.onSelect}
      />
      {chosen ? <EventDetail event={chosen} order={chosenIndex + 1} total={events.length} /> : null}
    </div>
  );
}
