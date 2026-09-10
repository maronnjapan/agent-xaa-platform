import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { TimelineTask } from '../../activity/query.js';
import { REPLAY_MOTION_MS, REPLAY_STEP_MS } from '../replay/config.js';
import { buildFrame } from '../replay/geometry.js';
import { trailOf } from '../replay/plan.js';
import { buildStoryPlan, chapterAt, chapterState, type StoryChapter } from '../replay/story.js';
import { thinkingByEvent } from '../replay/thinking.js';
import { roleOf } from '../roles.js';
import { CastRoster, CastSpotlight, RoleCard } from './cast-panel.js';
import { OutcomeBadge } from './outcome-badge.js';
import { ReplayCanvas, type ReplayControls } from './replay-canvas.js';
import { SimulatedBadge } from './simulated-badge.js';
import { ThinkingPanel } from './thinking-panel.js';
import type { Element } from '../element.js';

/** Screen furniture: what the panel and its buttons are called. None of it is about an event (RULE-54). */
export const STORY_OPEN_LABEL = '流れを通しで見る';
export const STORY_CAPTION = '流れを通しで見る';
export const STORY_NOTE = 'まず図に出てくる登場人物を1つずつ紹介し、そのあとログインから終了までを、区切りをまたいで1手ずつ再生します。「再生」で始まり、区切りが終わると次の区切りへそのまま進みます。区切りの名前を押すと、そこから見られます。';
export const STORY_CLOSE_LABEL = '閉じる';
export const STORY_SPEED_LABEL = '速さ';
export const STORY_FULLSCREEN_LABEL = '全画面で見る';
export const STORY_FULLSCREEN_EXIT_LABEL = '全画面をやめる';
export const STORY_CHAPTERS_LABEL = '区切り';

/**
 * How fast the story goes, as a factor over the ordinary pace.
 *
 * The ordinary step is long enough to read the caption and the reasoning beside it
 * (docs 11 §5.2). A person showing the story to a room is talking over it rather than
 * reading it, and for them the same step is a wait — so the panel offers one faster
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

/**
 * One agent's whole story, played through in one place.
 *
 * Each task's card already replays that task. What a person showing the platform to
 * someone else needs is the thing no card has: the login, the decision, the agent being
 * made, the tool calls and the end, one after another on one picture, without opening
 * four cards and pressing 再生 four times. So this lays the finished tasks' steps end to
 * end (`buildStoryPlan`) and plays them as one — the same diagram, the same pace, the
 * same caption and the same panel of what the agent was thinking, and a strip of
 * chapters over the picture that says which part of the story is on.
 *
 * It opens on the cast. Before anything plays, the panel beside the picture lists who
 * is in the story — each part's name, what it is like, what it does and does not do —
 * and the first chapter of the story is that same list, played: each box lit in turn
 * with its card beside it. A viewer is told who is who before anyone moves, which is
 * the question the boxes' names raise and the one a demonstration must answer first.
 *
 * It is the same data as the cards below it, and it is not a demo screen: nothing
 * about it is different when the story is a demonstration, except that a scripted
 * chapter carries its label (RULE-58). Pressing a chapter starts from there. The step
 * the story is on is reported upward, so the rail below can mark the chapter and its
 * row — one state, drawn in two places.
 *
 * Nothing plays on its own, and nothing loops (docs 11 §5.2). The panel exists only
 * once a person has pressed 「流れを通しで見る」, so the server never renders it and a page
 * without script never shows it — the cards, which the server does render, are the
 * account a person can always read.
 *
 * The picture can be taken to the whole screen, which is what a projector wants; the
 * request goes to the browser and nothing is decided from its answer, so a browser
 * without the ability simply keeps the panel where it is.
 */
export function RunPlayer(props: {
  runId: string;
  tasks: readonly TimelineTask[];
  /** Told which task and event the picture is on, so the rail below can mark them. */
  onCurrentEvent?: (taskKey: string | null, eventId: string | null) => void;
  onClose?: () => void;
}): Element {
  const plan = useMemo(() => buildStoryPlan(props.tasks, { introduce: true }), [props.tasks]);
  const thinking = useMemo(() => thinkingByEvent(plan.events), [plan]);

  const [index, setIndex] = useState(NOTHING_PLAYED);
  const [state, setState] = useState<ReplayState>('idle');
  const [speed, setSpeed] = useState<StorySpeed>(1);
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const panel = useRef<HTMLElement>(null);

  const last = plan.steps.length - 1;
  const settle = useCallback((next: number, playing: boolean): void => {
    setIndex(next);
    setState(next >= last ? 'finished' : (playing ? 'playing' : 'paused'));
  }, [last]);

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
    play: () => { if (state !== 'finished') settle(Math.max(index, 0), true); },
    pause: () => setState((current) => (current === 'playing' ? 'paused' : current)),
    next: () => { if (state !== 'finished') settle(Math.min(index + 1, last), false); },
    restart: () => settle(0, true),
  }), [state, index, last, settle]);

  /*
   * A chapter is pressed to be watched from, so it starts playing unless the person had
   * deliberately paused — a paused story stays paused and merely moves.
   */
  const jumpTo = useCallback((chapter: StoryChapter): void => {
    settle(chapter.from, state !== 'paused');
  }, [settle, state]);

  const step = index >= 0 ? plan.steps[index] : undefined;
  const chapter = chapterAt(plan, index);
  const frame = step ? buildFrame(step, plan.visible) : null;
  const trail = useMemo(
    () => (index >= 0 ? trailOf(plan.steps, index).map((earlier) => buildFrame(earlier, plan.visible)) : []),
    [plan, index],
  );
  // An introduction belongs to no task, so it marks nothing on the rail below.
  const currentTaskKey = step?.taskKey ? step.taskKey : null;
  const currentEventId = step && !step.cast ? step.eventId : null;
  const opened = openNode === null ? null : roleOf(openNode);

  /*
   * Reported from an effect rather than during the render that moved the step, for the
   * same reason the task's own picture does: the listener is a parent's state. Held in
   * a ref so a parent that passes a fresh closure each time does not restart the
   * reporting.
   */
  const report = useRef(props.onCurrentEvent);
  useEffect(() => { report.current = props.onCurrentEvent; });
  useEffect(() => { report.current?.(currentTaskKey, currentEventId); }, [currentTaskKey, currentEventId]);

  /* Whether this panel is the thing on the whole screen, read back from the browser rather than assumed. */
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const sync = (): void => setFullscreen(panel.current !== null && document.fullscreenElement === panel.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const leaveFullscreen = (): void => {
    if (typeof document === 'undefined' || panel.current === null || document.fullscreenElement !== panel.current) return;
    if (typeof document.exitFullscreen !== 'function') return;
    Promise.resolve(document.exitFullscreen()).catch(() => undefined);
  };

  const toggleFullscreen = (): void => {
    const element = panel.current;
    if (!element || typeof document === 'undefined') return;
    if (document.fullscreenElement === element) {
      leaveFullscreen();
      return;
    }
    if (typeof element.requestFullscreen !== 'function') return;
    Promise.resolve(element.requestFullscreen()).catch(() => undefined);
  };

  const close = (): void => {
    leaveFullscreen();
    props.onClose?.();
  };

  const storyKey = `story:${props.runId}`;
  const first = plan.chapters[0];

  return (
    <section
      ref={panel}
      className="story"
      data-story-player={props.runId}
      data-story-state={state}
      data-story-fullscreen={String(fullscreen)}
    >
      <header className="story-head">
        <h3 className="story-caption">{STORY_CAPTION}</h3>
        <div className="story-tools">
          <div className="story-speed" role="group" aria-label={STORY_SPEED_LABEL}>
            <span className="story-speed-label">{STORY_SPEED_LABEL}</span>
            {STORY_SPEEDS.map((option) => (
              <button
                key={option.factor}
                type="button"
                className={speed === option.factor ? 'is-selected' : ''}
                data-action="story-speed"
                data-speed={String(option.factor)}
                aria-pressed={speed === option.factor}
                onClick={() => setSpeed(option.factor)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" data-action="story-fullscreen" onClick={toggleFullscreen}>
            {fullscreen ? STORY_FULLSCREEN_EXIT_LABEL : STORY_FULLSCREEN_LABEL}
          </button>
          <button type="button" className="secondary" data-action="story-close" onClick={close}>{STORY_CLOSE_LABEL}</button>
        </div>
        <p className="story-note">{STORY_NOTE}</p>
      </header>

      <ol className="story-chapters" data-story-chapters="true" aria-label={STORY_CHAPTERS_LABEL}>
        {plan.chapters.map((entry) => (
          <li
            key={entry.taskKey}
            data-chapter={entry.taskKey}
            data-chapter-task={entry.taskId}
            data-chapter-kind={entry.kind}
            data-chapter-state={chapterState(entry, index)}
          >
            <button
              type="button"
              data-action="story-chapter"
              {...(chapter?.index === entry.index ? { 'aria-current': 'step' as const } : {})}
              onClick={() => jumpTo(entry)}
            >
              <span className="chapter-kind">{entry.label}</span>
              <span className="chapter-title">{entry.title}</span>
              <span className="chapter-meta">
                {entry.simulated ? <SimulatedBadge position="row" /> : null}
                {entry.kind === 'cast' ? null : <OutcomeBadge outcome={entry.outcome} phase={entry.phase} />}
                <span className="chapter-count">{`${entry.count} 手`}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/*
        * Which chapter the picture is in, and how far through it — the two things the
        * canvas's own count (which runs across the whole story) does not say. The line
        * is keyed by the chapter, so a new chapter mounts a new line and slides it in:
        * the seam between two tasks is seen as well as counted. Both strings are the
        * chapter's fixed name and its publisher's title.
        */}
      {chapter && step
        ? (
          <motion.p
            key={chapter.taskKey}
            className="story-now"
            data-field="story-now"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
          >
            <span className="story-now-kind" data-field="story-now-kind">{chapter.label}</span>
            <span className="story-now-title" data-field="story-now-title">{chapter.title}</span>
            <span className="story-now-step" data-field="story-now-step">{`${index - chapter.from + 1} / ${chapter.count} 手目`}</span>
          </motion.p>
        )
        : null}

      <div className="story-stage">
        <ReplayCanvas
          taskId={chapter?.taskId ?? first?.taskId ?? ''}
          taskKey={storyKey}
          visible={plan.visible}
          simulated={chapter?.simulated ?? false}
          state={state}
          frame={frame}
          trail={trail}
          total={plan.steps.length}
          controls={controls}
          motionMs={REPLAY_MOTION_MS / speed}
          openNode={openNode}
          onOpenNode={setOpenNode}
        />
        {/*
          * Beside the picture: the cast before anything plays, the part being introduced
          * while the introduction plays, and what the agent was thinking once the story
          * proper is on. One place, three answers to "who is this and what is it doing".
          */}
        {step?.cast && chapter
          ? <CastSpotlight actor={step.cast} position={`${index - chapter.from + 1} / ${chapter.count}`} />
          : state === 'idle' && plan.cast.length > 0
            ? <CastRoster actors={plan.cast} />
            : (
              <ThinkingPanel
                taskKey={storyKey}
                frame={currentEventId === null ? null : thinking.get(currentEventId) ?? null}
              />
            )}
      </div>

      {opened
        ? (
          <div className="replay-role-open" data-role-open={opened.id}>
            <RoleCard actor={opened} />
            <button type="button" data-action="close-role" onClick={() => setOpenNode(null)}>閉じる</button>
          </div>
        )
        : null}
    </section>
  );
}
