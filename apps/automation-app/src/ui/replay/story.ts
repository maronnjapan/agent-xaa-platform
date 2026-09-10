import type { ActivityEvent } from '@xaa/contracts';
import type { TimelineTask } from '../../activity/query.js';
import { taskKeyOf } from '../../activity/task-key.js';
import { taskLabelOf, type TaskKind } from '../labels.js';
import { rolesFor, type ActorRole } from '../roles.js';
import { REPLAY_STEP_MS } from './config.js';
import { nodeIdFor, visibleNodeIds } from './nodes.js';
import { buildReplayPlan, type ReplayEvent, type ReplayStep } from './plan.js';

/**
 * One agent's whole story as a single sequence of steps, with the boundaries between
 * its tasks kept.
 *
 * Each task already has a picture of its own — the card it opens into replays exactly
 * that task. What that picture cannot show is the shape of the whole: that a person
 * logged in and wrote the work, that the platform decided what the agent may do and
 * then made it, that the agent acted and was answered, and that it ended. Watching
 * that takes opening four cards and pressing 再生 four times, which is fine for reading
 * and useless for showing someone. So the tasks' plans are laid end to end and played
 * as one, in the order the work happened, and the seams between them are kept as
 * chapters so a viewer can see which part of the story is on.
 *
 * Before the first task, the story can introduce its cast: one step per box the story
 * involves, in the order the story meets them, each lighting the box and saying what
 * the part is. A person watching for the first time is told who is who before anyone
 * moves — which is the question the boxes' names raise, and the one a demonstration
 * has to answer first.
 *
 * Nothing here reads an event for its meaning. A chapter's name is the task's fixed
 * word (準備 / 作業 1 / 終了 / デモ), its title is the publisher's own last sentence about
 * the task, and its outcome is the terminal event's — the same three things the task's
 * head already prints (RULE-54). The steps are the ones `buildReplayPlan` would give
 * each task on its own, re-numbered so that the count across the story runs from one.
 * The introduction is screen furniture: the role dictionary, played.
 */

/** What the introduction chapter is called, and how it stands in for a task id. */
export const CAST_CHAPTER_LABEL = '登場人物';
export const CAST_CHAPTER_KEY = 'cast';

/** The introduction chapter's title: how many parts the story is about to introduce. */
export function castChapterTitle(count: number): string {
  return `図に出てくる ${count} つの役割`;
}

export interface StoryChapter {
  index: number;
  taskKey: string;
  taskId: string;
  /** The task's kind, or `cast` for the introduction, which is no task at all. */
  kind: TaskKind | 'cast';
  /** What the task is called on screen: 準備, 作業 1, 終了, デモ：…, or 登場人物. */
  label: string;
  /** The publisher's last word on the task — its terminal event's title. */
  title: string;
  /** The terminal event's `outcome` and `phase`, which is how the head draws its badge. */
  outcome: string;
  phase: string;
  simulated: boolean;
  /** Where the chapter's steps sit in the story: the first index and how many follow. */
  from: number;
  count: number;
}

export interface StoryStep extends ReplayStep {
  /** Which chapter the step belongs to, as an index into `chapters`. */
  chapter: number;
  /** The task the step belongs to; empty for an introduction, which belongs to none. */
  taskKey: string;
  taskId: string;
}

export interface StoryPlan {
  chapters: StoryChapter[];
  steps: StoryStep[];
  /** Every box any chapter involved — the diagram stays the same across the story. */
  visible: Set<string>;
  /** Every event of every chapter, for the panel that shows what the agent was thinking. */
  events: ActivityEvent[];
  /** The parts the story introduces, in the order it introduces them. Empty when it does not. */
  cast: ActorRole[];
}

export interface StoryOptions {
  /** Open with the cast: one step per box the story involves, before the first task. */
  introduce?: boolean;
}

type CompletedTask = Extract<TimelineTask, { status: 'completed' }>;

/**
 * The story of one run, from the tasks in the order the page already holds them:
 * provisioning, then the numbered tasks as they finished, then lifecycle.
 *
 * A running task has no chapter. There is nothing complete to play, and a partial
 * chapter would be a story that has not happened (RULE-59). Its row on the rail still
 * says it exists.
 *
 * The visible boxes are the union over the chapters rather than each chapter's own.
 * A picture whose boxes appeared and vanished at every seam would make a viewer read
 * the change of scenery as an event; the fixed picture is what lets the dot's travel
 * across the whole platform be followed (DEC-APP-06). The introduction covers exactly
 * those boxes, in the dictionary's order — the order of the story, not of the diagram.
 */
export function buildStoryPlan(tasks: readonly TimelineTask[], options: StoryOptions = {}): StoryPlan {
  const finished = tasks.filter((task): task is CompletedTask => task.status === 'completed');
  const visible = new Set<string>();
  for (const task of finished) {
    for (const id of visibleNodeIds(task.events)) visible.add(id);
  }

  const chapters: StoryChapter[] = [];
  const steps: StoryStep[] = [];
  const events: ActivityEvent[] = [];
  const cast = options.introduce ? rolesFor(visible) : [];

  if (cast.length > 0) {
    for (const actor of cast) steps.push(introduction(actor, steps.length, chapters.length));
    chapters.push({
      index: chapters.length,
      taskKey: CAST_CHAPTER_KEY,
      taskId: CAST_CHAPTER_KEY,
      kind: 'cast',
      label: CAST_CHAPTER_LABEL,
      title: castChapterTitle(cast.length),
      outcome: 'info',
      phase: '',
      simulated: false,
      from: 0,
      count: cast.length,
    });
  }

  for (const task of finished) {
    const taskKey = taskKeyOf(task);
    const from = steps.length;
    const own = buildReplayPlan(task.events as readonly ReplayEvent[], nodeIdFor);
    for (const step of own) {
      steps.push({ ...step, index: from + step.index, chapter: chapters.length, taskKey, taskId: task.task_id });
    }
    chapters.push(chapterOf(task, taskKey, chapters.length, from, own.length));
    events.push(...task.events);
  }

  return { chapters, steps, visible, events, cast };
}

/**
 * One introduction: the box lit on its own, its phrase as the step's name and what it
 * does as the step's sentence, both from the dictionary. It has the pace of any other
 * step, because the sentence is read in the same standing-still time.
 */
function introduction(actor: ActorRole, index: number, chapter: number): StoryStep {
  return {
    index,
    eventId: `${CAST_CHAPTER_KEY}:${actor.id}`,
    kind: 'self',
    from: actor.id,
    to: null,
    label: actor.role,
    message: actor.does,
    outcome: 'info',
    phase: '',
    blocked: false,
    stopRatio: 1,
    delayMs: REPLAY_STEP_MS,
    cast: actor,
    chapter,
    taskKey: '',
    taskId: CAST_CHAPTER_KEY,
  };
}

function chapterOf(task: CompletedTask, taskKey: string, index: number, from: number, count: number): StoryChapter {
  const kind = taskLabelOf(task.task_id);
  const terminal = task.events[task.events.length - 1];
  return {
    index,
    taskKey,
    taskId: task.task_id,
    kind: kind.kind,
    label: kind.label,
    title: terminal?.title ?? '',
    outcome: task.terminal_outcome,
    phase: terminal?.phase ?? 'tool_call',
    simulated: task.events.some((event) => event.is_simulated === true),
    from,
    count,
  };
}

/** The chapter a step index falls in, or null before anything has played. */
export function chapterAt(plan: StoryPlan, index: number): StoryChapter | null {
  const step = index >= 0 ? plan.steps[index] : undefined;
  return step ? plan.chapters[step.chapter] ?? null : null;
}

/** How a chapter is drawn against the step the story is on: before it, in it, or past it. */
export function chapterState(chapter: StoryChapter, index: number): 'waiting' | 'current' | 'played' {
  if (index < chapter.from) return 'waiting';
  if (index < chapter.from + chapter.count) return 'current';
  return 'played';
}

/** The chapter that replays a task, by the task's id; null for a task the story has no chapter for. */
export function chapterOfTask(plan: StoryPlan, taskId: string): StoryChapter | null {
  return plan.chapters.find((chapter) => chapter.kind !== 'cast' && chapter.taskId === taskId) ?? null;
}

/**
 * The first step that replays an event: the first of its exchanges, when it has
 * several. Null for an event the story does not play.
 */
export function stepOfEvent(plan: StoryPlan, eventId: string): StoryStep | null {
  return plan.steps.find((step) => step.eventId === eventId) ?? null;
}

/** The steps of one chapter, in order. */
export function stepsOf(plan: StoryPlan, chapter: StoryChapter): StoryStep[] {
  return plan.steps.slice(chapter.from, chapter.from + chapter.count);
}
