import { buildReplayPlan, isFinished, type ReplayEvent, type ReplayStep } from './replay-plan.js';
import { MIN_STOP_RATIO, REPLAY_STEP_MS, STOP_CLEARANCE, STOP_RATIO_STEP } from './replay-config.js';
import { NODE_HALF_HEIGHT, NODE_HALF_WIDTH } from '../../src/ui/replay/nodes.js';
import { emphasisClass } from '../../src/ui/replay/emphasis.js';

const SOURCE_TO_NODE: Readonly<Record<string, string>> = {
  'human-user': 'human-user', 'automation-app': 'automation-app',
  'authorization-platform': 'authorization-platform', authorization: 'authorization-platform',
  'agent-provisioner': 'agent-provisioner', provisioner: 'agent-provisioner',
  'agent-op': 'agent-op', 'agent-runtime': 'agent-runtime',
  'resource-as': 'resource-as', 'resource-api': 'resource-api',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Point { x: number; y: number }

/** What the buttons on the canvas can do to a replay that is already running. */
export interface ReplayController {
  play(): void;
  pause(): void;
  next(): void;
  restart(): void;
  stop(): void;
}

interface PlayOptions {
  /**
   * Whether to start moving straight away. Default true: a person who clicked the
   * canvas asked to watch it. The step and pause buttons pass false, so pressing
   * either on a replay that has not started yet does not first play a frame nobody
   * asked for.
   */
  autoplay?: boolean;
  /**
   * The written log for this task, if the page rendered one.
   *
   * The replay marks the entry it has reached and leaves everything else alone. It
   * never writes into it: every word in that list was server-rendered from what the
   * publisher wrote, and a browser that composed a line would be composing a sentence
   * about an event it did not witness (RULE-54).
   */
  log?: { querySelectorAll(selector: string): ArrayLike<Element> } | null;
}

/**
 * Plays a finished task's events across the fixed diagram.
 *
 * The DOM work is all that lives here; the sequencing and the stop position come from
 * `replay-plan.ts`, which has no DOM in it and can therefore be tested directly. The
 * geometry constants and the emphasis rule come from the modules the server renders
 * with, so a step's colour and the badge on its row are decided by the same function.
 *
 * Messages accumulate rather than replace: a person who looks away for one step should
 * still be able to read what they missed. When the last step lands, the root is marked
 * `finished` and the timer is cleared — nothing loops, because a replay that restarted
 * on its own would make a viewer doubt what they just saw.
 *
 * It returns a controller rather than a cleanup function because a replay that can only
 * be watched at one speed is a film. The step that says something surprising is exactly
 * the one a person wants to stop on and read the record under.
 */
export function playReplay(root: HTMLElement, events: readonly ReplayEvent[], options: PlayOptions = {}): ReplayController {
  const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
  const messages = root.querySelector('[data-messages]');
  const banner = root.querySelector('[data-banner]');
  const progress = root.querySelector('[data-field="replay-progress"]');
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const draw = (current: ReplayStep): void => {
    if (current.from === null && current.to === null) {
      // An event with no node of its own: it says something happened to the agent
      // rather than between two services, so it gets the banner and no arrow.
      if (banner) banner.textContent = current.message;
    } else {
      drawArrow(root, current);
    }
    if (messages) {
      const line = root.ownerDocument.createElement('li');
      line.setAttribute('data-step-index', String(current.index));
      line.textContent = current.message;
      messages.appendChild(line);
    }
    if (progress) progress.textContent = `${current.index + 1} / ${plan.length}`;
    markLog(options.log, current.eventId);
  };

  const advance = (schedule: boolean): void => {
    const current = plan[index];
    if (!current) return;
    draw(current);
    if (isFinished(plan, index)) {
      root.setAttribute('data-replay-state', 'finished');
      clearTimer();
      return;
    }
    index += 1;
    if (schedule) timer = setTimeout(() => advance(true), REPLAY_STEP_MS);
  };

  const play = (): void => {
    if (root.getAttribute('data-replay-state') === 'finished') return;
    clearTimer();
    root.setAttribute('data-replay-state', 'playing');
    advance(true);
  };

  resetNodes(root);
  if (options.autoplay === false) {
    root.setAttribute('data-replay-state', 'paused');
  } else {
    root.setAttribute('data-replay-state', 'playing');
    advance(true);
  }

  return {
    play,
    pause() {
      clearTimer();
      if (root.getAttribute('data-replay-state') === 'playing') root.setAttribute('data-replay-state', 'paused');
    },
    next() {
      clearTimer();
      if (root.getAttribute('data-replay-state') === 'finished') return;
      root.setAttribute('data-replay-state', 'paused');
      advance(false);
    },
    restart() {
      clearTimer();
      emptyOut(root.querySelector('[data-arrows]'));
      emptyOut(root.querySelector('[data-dots]'));
      emptyOut(messages);
      if (banner) banner.textContent = '';
      resetNodes(root);
      resetLog(options.log);
      index = 0;
      root.setAttribute('data-replay-state', 'playing');
      advance(true);
    },
    stop: clearTimer,
  };
}

/**
 * Which written entry the picture is currently on.
 *
 * Three states rather than two: an entry the replay has passed reads differently from
 * one it has not reached yet, and a person who paused halfway needs to see where the
 * boundary is. One event can span several steps — a tool call is four exchanges — so
 * the entry stays `current` for all of them rather than flickering.
 */
function markLog(log: PlayOptions['log'], eventId: string): void {
  if (!log) return;
  let reached = false;
  for (const entry of Array.from(log.querySelectorAll('[data-event-id]'))) {
    if (entry.getAttribute('data-event-id') === eventId) {
      entry.setAttribute('data-entry-state', 'current');
      reached = true;
      continue;
    }
    entry.setAttribute('data-entry-state', reached ? 'waiting' : 'played');
  }
}

function resetLog(log: PlayOptions['log']): void {
  if (!log) return;
  for (const entry of Array.from(log.querySelectorAll('[data-event-id]'))) {
    entry.setAttribute('data-entry-state', 'waiting');
  }
}

/**
 * Removes what a previous run drew, without assuming a full DOM.
 *
 * `firstChild` is absent on the test double, so the loop simply does not run there and
 * nothing throws — the unit suite exercises a single pass, which is what it is for.
 */
function emptyOut(element: Element | null): void {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
}

/**
 * Clears the reached marks the page was served with.
 *
 * Every box starts the page marked unreached, which is true before anything plays. Once
 * a replay is running the mark means something narrower — "this step set off for here
 * and did not arrive" — and that only reads if the boxes this task never involved carry
 * no verdict at all (RULE-54).
 */
function resetNodes(root: HTMLElement): void {
  root.querySelectorAll('[data-node]').forEach((node) => { node.setAttribute('data-reached', ''); });
}

function drawArrow(root: HTMLElement, step: ReplayStep): void {
  const arrows = root.querySelector('[data-arrows]');
  const start = step.from === null ? null : centreOf(root, step.from);
  const finish = step.to === null ? null : centreOf(root, step.to);
  // A step whose destination is unknown moves nothing: an arrow needs two ends, and
  // inventing one would draw a call that was never made.
  if (!arrows || !start || !finish) return;
  // The lines live behind the boxes and the dots in front. A canvas with only the one
  // layer — the shape every test double builds — puts both where it can.
  const dots = root.querySelector('[data-dots]') ?? arrows;
  const stop = edgeOf(finish, start);
  const stopRatio = step.blocked ? clearStopRatio(root, step, start, stop) : step.stopRatio;
  const document_ = root.ownerDocument;

  const path = document_.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'replay-arrow');
  path.setAttribute('data-step-index', String(step.index));
  path.setAttribute('d', lineBetween(start, stop));
  arrows.appendChild(path);

  const emphasis = emphasisClass(step.outcome, step.phase);
  const dot = document_.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', step.blocked ? 'replay-dot is-blocked' : 'replay-dot');
  dot.setAttribute('data-step-index', String(step.index));
  dot.setAttribute('data-from', step.from ?? '');
  dot.setAttribute('data-to', step.to ?? '');
  dot.setAttribute('data-emphasis', emphasis);
  if (step.blocked) dot.setAttribute('data-blocked', 'true');
  dot.setAttribute('r', '6');
  // The travel is one CSS animation whose length is the step length; the browser is
  // told how far to go and how long to take, and nothing here moves the dot by hand.
  dot.style.setProperty('offset-path', `path('${lineBetween(start, stop)}')`);
  dot.style.setProperty('--step-ms', `${REPLAY_STEP_MS}ms`);
  dot.style.setProperty('--stop-ratio', String(stopRatio));
  dots.appendChild(dot);

  if (step.blocked) dots.appendChild(stopMark(document_, pointAt(start, stop, stopRatio), emphasis));

  const target = step.to === null ? null : root.querySelector(`[data-node="${step.to}"]`);
  // A blocked step never arrives, so the destination stays explicitly unreached.
  if (target) target.setAttribute('data-reached', step.blocked ? 'false' : 'true');
}

/**
 * Where a refused movement is allowed to come to rest.
 *
 * The plan says how far along the path a refusal stops, and on a short hop that is
 * exactly right. On a long one — Agent Runtime to Resource API, with the Resource AS
 * between them — the same fraction puts the stop mark on top of a box that had nothing
 * to do with the refusal, which reads as "the Resource AS turned it down". So the mark
 * is walked back until it is clear of every box except the one the movement left.
 *
 * A box the replay is not showing cannot mislead anyone, so a hidden one is ignored.
 */
function clearStopRatio(root: HTMLElement, step: ReplayStep, start: Point, stop: Point): number {
  const others: Point[] = [];
  root.querySelectorAll('[data-node]').forEach((node) => {
    if (node.getAttribute('data-node') === step.from || node.getAttribute('hidden') !== null) return;
    const x = Number(node.getAttribute('data-x'));
    const y = Number(node.getAttribute('data-y'));
    if (Number.isFinite(x) && Number.isFinite(y)) others.push({ x, y });
  });
  const clear = (ratio: number): boolean => {
    const at = pointAt(start, stop, ratio);
    return others.every((node) => Math.abs(at.x - node.x) > NODE_HALF_WIDTH + STOP_CLEARANCE
      || Math.abs(at.y - node.y) > NODE_HALF_HEIGHT + STOP_CLEARANCE);
  };
  for (let ratio = step.stopRatio; ratio > MIN_STOP_RATIO; ratio -= STOP_RATIO_STEP) {
    if (clear(ratio)) return Math.round(ratio * 100) / 100;
  }
  return MIN_STOP_RATIO;
}

/** The refusal, drawn where the movement stopped rather than written beside it. */
function stopMark(document_: Document, at: Point, emphasis: string): SVGElement {
  const mark = document_.createElementNS(SVG_NS, 'g');
  mark.setAttribute('class', 'replay-stop');
  mark.setAttribute('data-stop', 'true');
  mark.setAttribute('data-emphasis', emphasis);
  mark.setAttribute('transform', `translate(${at.x},${at.y})`);
  const ring = document_.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('r', '9');
  const bar = document_.createElementNS(SVG_NS, 'path');
  bar.setAttribute('d', 'M -6 -6 L 6 6');
  mark.appendChild(ring);
  mark.appendChild(bar);
  return mark;
}

function centreOf(root: HTMLElement, nodeId: string): Point | null {
  const node = root.querySelector(`[data-node="${nodeId}"]`);
  const x = Number(node?.getAttribute('data-x'));
  const y = Number(node?.getAttribute('data-y'));
  return Number.isFinite(x) && Number.isFinite(y) && node ? { x, y } : null;
}

/**
 * Where the arrow meets the destination box.
 *
 * Ending at the centre would draw every arrow underneath the box it points at, and a
 * step that stopped at sixty per cent of a centre-to-centre line would still overlap
 * the destination — which is the one thing a blocked step must not look like.
 */
function edgeOf(target: Point, from: Point): Point {
  const dx = from.x - target.x;
  const dy = from.y - target.y;
  if (dx === 0 && dy === 0) return target;
  const horizontal = dx === 0 ? Number.POSITIVE_INFINITY : NODE_HALF_WIDTH / Math.abs(dx);
  const vertical = dy === 0 ? Number.POSITIVE_INFINITY : NODE_HALF_HEIGHT / Math.abs(dy);
  const scale = Math.min(1, horizontal, vertical);
  return { x: target.x + dx * scale, y: target.y + dy * scale };
}

function pointAt(from: Point, to: Point, ratio: number): Point {
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function lineBetween(from: Point, to: Point): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}
