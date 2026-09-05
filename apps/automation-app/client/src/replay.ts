import { buildReplayPlan, isFinished, type ReplayEvent, type ReplayStep } from './replay-plan.js';
import {
  MIN_STOP_RATIO, REPLAY_MOTION_MS, REPLAY_STEP_MS, STOP_CLEARANCE, STOP_RATIO_STEP,
} from './replay-config.js';
import {
  NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_NODES, REPLAY_WIDTH,
} from '../../src/ui/replay/nodes.js';
import { emphasisClass } from '../../src/ui/replay/emphasis.js';

const SOURCE_TO_NODE: Readonly<Record<string, string>> = {
  'human-user': 'human-user', 'automation-app': 'automation-app',
  'authorization-platform': 'authorization-platform', authorization: 'authorization-platform',
  'agent-provisioner': 'agent-provisioner', provisioner: 'agent-provisioner',
  'agent-op': 'agent-op', 'agent-runtime': 'agent-runtime',
  'resource-as': 'resource-as', 'resource-api': 'resource-api',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * How far outside a row a detour runs, and how far outside a row a label sits.
 *
 * Both are measured from the edge of a box rather than from its centre, so they stay
 * correct if a box ever changes size. The rows are 160 apart and 60 tall, which leaves
 * a hundred units of empty canvas between them and enough above and below for one line
 * of text — those three bands are the only places anything is allowed to be drawn that
 * is not a box (RULE-54 has nothing to say about geometry, but a person who cannot read
 * the picture cannot check the claim it makes).
 */
const LANE_CLEARANCE = 60;
const LABEL_CLEARANCE = 12;

/** How far a label is kept from the left and right edges of the frame. */
const LABEL_MARGIN = 110;

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
 * Every step puts words on the screen as well as motion: the exchange's name is drawn
 * beside its arrow, the two boxes involved are lit, and the caption under the picture
 * shows the route, the name and the publisher's own sentence for the step. None of
 * those words is composed here — they are the hop's `label` and `message`, the event's
 * `title` and `message`, and the boxes' fixed captions, placed rather than written.
 *
 * One step is on the canvas at a time. Everything the previous step drew is taken away
 * before the next one is drawn, because a picture that accumulated its arrows answered
 * "what is happening now" with eight overlapping lines and a wall of text that had
 * stopped being about anything. What did happen, in order and in full, is the written
 * log beside the picture; it is server-rendered, it never scrolls away, and the replay
 * marks which of its entries the picture has reached.
 *
 * When the last step lands, the root is marked `finished` and the timer is cleared —
 * nothing loops, because a replay that restarted on its own would make a viewer doubt
 * what they just saw.
 *
 * It returns a controller rather than a cleanup function because a replay that can only
 * be watched at one speed is a film. The step that says something surprising is exactly
 * the one a person wants to stop on and read the record under.
 */
export function playReplay(root: HTMLElement, events: readonly ReplayEvent[], options: PlayOptions = {}): ReplayController {
  const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
  const banner = root.querySelector('[data-banner]');
  const progress = root.querySelector('[data-field="replay-progress"]');
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const clearCanvas = (): void => {
    emptyOut(root.querySelector('[data-arrows]'));
    emptyOut(root.querySelector('[data-labels]'));
    emptyOut(root.querySelector('[data-dots]'));
    if (banner) banner.textContent = '';
  };

  const draw = (current: ReplayStep): void => {
    // The previous step goes first, always. What is on the canvas is this step and
    // nothing else, so a person looking at it is never reading last step's words.
    clearCanvas();
    lightBoxes(root, current);
    if (current.kind === 'banner') {
      // An event with no node of its own: it says something happened to the agent
      // rather than between two services, so it gets the banner and no arrow.
      if (banner) banner.textContent = current.message;
    } else if (current.kind === 'self') {
      drawPulse(root, current);
    } else {
      drawArrow(root, current);
    }
    if (progress) progress.textContent = `${current.index + 1} / ${plan.length}`;
    writeCaption(root, current, plan.length);
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
      clearCanvas();
      resetNodes(root);
      clearCaption(root);
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

/** Removes what the step before drew. */
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
  root.querySelectorAll('[data-node]').forEach((node) => {
    node.setAttribute('data-reached', '');
    node.setAttribute('data-active', '');
  });
}

/**
 * The boxes a step involves, lit while it is the current one.
 *
 * `from` and `to` are told apart so the eye can follow the direction without waiting
 * for the dot; a self step lights its one box as `self`. Everything else goes dark,
 * so the two lit boxes are always this step's and never a previous one's.
 */
function lightBoxes(root: HTMLElement, step: ReplayStep): void {
  root.querySelectorAll('[data-node]').forEach((node) => {
    const id = node.getAttribute('data-node');
    const role = id !== null && id === step.from
      ? (step.kind === 'self' ? 'self' : 'from')
      : (id !== null && id === step.to ? 'to' : '');
    node.setAttribute('data-active', role);
  });
}

/**
 * The words under the picture for the current step.
 *
 * Route, name, sentence — three separate elements, each holding one string the
 * publisher (or the diagram's own fixed captions) wrote. The browser joins nothing
 * into a sentence of its own.
 */
function writeCaption(root: HTMLElement, step: ReplayStep, total: number): void {
  const caption = root.querySelector('[data-caption]');
  if (!caption) return;
  caption.setAttribute('data-caption-state', step.blocked ? 'blocked' : 'playing');
  caption.setAttribute('data-caption-emphasis', emphasisClass(step.outcome, step.phase));
  const set = (field: string, text: string): void => {
    const target = caption.querySelector(`[data-field="${field}"]`);
    if (target) target.textContent = text;
  };
  set('caption-step', `${step.index + 1} / ${total}`);
  set('caption-route', routeOf(step));
  set('caption-label', step.label);
  set('caption-message', step.message);
}

function clearCaption(root: HTMLElement): void {
  const caption = root.querySelector('[data-caption]');
  if (!caption) return;
  caption.setAttribute('data-caption-state', 'idle');
  caption.setAttribute('data-caption-emphasis', '');
  for (const field of ['caption-step', 'caption-route', 'caption-label', 'caption-message']) {
    const target = caption.querySelector(`[data-field="${field}"]`);
    if (target) target.textContent = '';
  }
}

/** The boxes' own captions, joined by the diagram's arrow glyph: a route, not a sentence. */
function routeOf(step: ReplayStep): string {
  const from = step.from === null ? '' : boxLabel(step.from);
  const to = step.to === null ? '' : boxLabel(step.to);
  if (step.kind === 'move') return `${from} → ${to}`;
  return from || to;
}

function boxLabel(id: string): string {
  return REPLAY_NODES.find((node) => node.id === id)?.label ?? id;
}

/**
 * A step that moved nothing: a ring that swells around the box it happened in.
 *
 * Drawn in the dots layer beside the travelling circles, and marked with the step so a
 * restart can take it away with everything else.
 */
function drawPulse(root: HTMLElement, step: ReplayStep): void {
  const at = step.from === null ? (step.to === null ? null : centreOf(root, step.to)) : centreOf(root, step.from);
  const dots = root.querySelector('[data-dots]') ?? root.querySelector('[data-arrows]');
  if (!at || !dots) return;
  const ring = root.ownerDocument.createElementNS(SVG_NS, 'rect');
  ring.setAttribute('class', 'replay-pulse');
  ring.setAttribute('data-pulse', 'true');
  ring.setAttribute('data-step-index', String(step.index));
  ring.setAttribute('data-pulse-emphasis', emphasisClass(step.outcome, step.phase));
  ring.setAttribute('x', String(at.x - NODE_HALF_WIDTH - 4));
  ring.setAttribute('y', String(at.y - NODE_HALF_HEIGHT - 4));
  ring.setAttribute('width', String(NODE_HALF_WIDTH * 2 + 8));
  ring.setAttribute('height', String(NODE_HALF_HEIGHT * 2 + 8));
  ring.setAttribute('rx', '9');
  ring.style.setProperty('--motion-ms', `${REPLAY_MOTION_MS}ms`);
  dots.appendChild(ring);
  const box = step.from === null ? null : root.querySelector(`[data-node="${step.from}"]`);
  if (box) box.setAttribute('data-reached', 'true');
}

function drawArrow(root: HTMLElement, step: ReplayStep): void {
  const arrows = root.querySelector('[data-arrows]');
  const from = step.from === null ? null : centreOf(root, step.from);
  const to = step.to === null ? null : centreOf(root, step.to);
  // A step whose destination is unknown moves nothing: an arrow needs two ends, and
  // inventing one would draw a call that was never made.
  if (!arrows || !from || !to) return;
  // The lines live behind the boxes and the dots in front. A canvas with only the one
  // layer — the shape every test double builds — puts both where it can.
  const dots = root.querySelector('[data-dots]') ?? arrows;
  const labels = root.querySelector('[data-labels]') ?? dots;
  const route = routeAround(root, step, from, to);
  const stopRatio = step.blocked ? clearStopRatio(root, step, route) : step.stopRatio;
  const document_ = root.ownerDocument;
  const drawn = pathOf(route);

  const path = document_.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'replay-arrow');
  path.setAttribute('data-step-index', String(step.index));
  path.setAttribute('d', drawn);
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
  // The travel is one CSS animation whose length is the motion length; the browser is
  // told how far to go and how long to take, and nothing here moves the dot by hand.
  // `offset-distance` is a fraction of the path's own length, which is why the stop
  // ratio below is measured the same way rather than by counting corners.
  dot.style.setProperty('offset-path', `path('${drawn}')`);
  dot.style.setProperty('--motion-ms', `${REPLAY_MOTION_MS}ms`);
  dot.style.setProperty('--stop-ratio', String(stopRatio));
  dots.appendChild(dot);

  if (step.blocked) dots.appendChild(stopMark(document_, alongRoute(route, stopRatio), emphasis));
  if (step.label !== '') labels.appendChild(arrowLabel(document_, step, route, from, to, stopRatio));

  const target = step.to === null ? null : root.querySelector(`[data-node="${step.to}"]`);
  // A blocked step never arrives, so the destination stays explicitly unreached.
  if (target) target.setAttribute('data-reached', step.blocked ? 'false' : 'true');
}

/**
 * The path from one box to the other, kept off every box in between.
 *
 * Two things changed here from the straight centre-to-centre line this started as, and
 * both are the same complaint: a line drawn over a box says the line has something to
 * do with that box. The first is that both ends now sit on a box's edge rather than at
 * its centre, so no arrow is ever drawn underneath the box it left. The second is that
 * a hop between two boxes with a third between them — Agent Runtime to Resource API,
 * with the Resource AS in the way — leaves its row through the empty band between the
 * rows and comes back down at the far end, instead of being drawn straight through the
 * service that had nothing to do with it.
 *
 * The detour is decided by looking, not by arithmetic about columns: a box the replay
 * is not showing is not in the way, and a straight line is the better picture whenever
 * one is available.
 *
 * The result is the corners, in order. Everything that has to be placed along the path
 * — the dot, the stop mark, the label — is measured against this one list, so the shape
 * that is drawn and the shape that is measured cannot come apart.
 */
function routeAround(root: HTMLElement, step: ReplayStep, from: Point, to: Point): Point[] {
  const direct = [edgeOf(from, to), edgeOf(to, from)];
  const obstacles = otherBoxes(root, [step.from, step.to]);
  if (!crossesAny(direct, obstacles)) return direct;
  // Out of the row, along the empty band, and back in. Each end leaves and enters
  // through the face that looks at the band, so the riser comes off the box rather
  // than sliding down its side — read per end, not once, because the two ends are only
  // on the same row for the hops that need this today.
  const lane = laneFor(from);
  return [
    { x: from.x, y: from.y + inwardFrom(from.y) * NODE_HALF_HEIGHT },
    { x: from.x, y: lane },
    { x: to.x, y: lane },
    { x: to.x, y: to.y + inwardFrom(to.y) * NODE_HALF_HEIGHT },
  ];
}

/**
 * Which way the empty band between the rows lies from a given row: down, or up.
 *
 * Read off the boxes rather than written down, so a row added below the current two
 * would be answered correctly instead of by a constant that had stopped being true.
 */
function inwardFrom(y: number): number {
  return REPLAY_NODES.some((node) => node.y > y) ? 1 : -1;
}

/**
 * The empty band a detour runs along.
 *
 * A detour only ever happens between two boxes on the same row, because those are the
 * only pairs with a third box on the line between them. The band is therefore the gap
 * towards the other row — open canvas from either row, and the widest empty space the
 * diagram has.
 */
function laneFor(from: Point): number {
  return from.y + inwardFrom(from.y) * (NODE_HALF_HEIGHT + LANE_CLEARANCE);
}

/** Every visible box the step is not about; the ones a line must not be drawn over. */
function otherBoxes(root: HTMLElement, involved: readonly (string | null)[]): Point[] {
  const boxes: Point[] = [];
  root.querySelectorAll('[data-node]').forEach((node) => {
    const id = node.getAttribute('data-node');
    if (involved.includes(id) || node.getAttribute('hidden') !== null) return;
    const x = Number(node.getAttribute('data-x'));
    const y = Number(node.getAttribute('data-y'));
    if (Number.isFinite(x) && Number.isFinite(y)) boxes.push({ x, y });
  });
  return boxes;
}

const CROSSING_SAMPLES = 60;

/** True when any part of the route is drawn inside one of those boxes. */
function crossesAny(route: readonly Point[], boxes: readonly Point[]): boolean {
  if (boxes.length === 0) return false;
  for (let sample = 0; sample <= CROSSING_SAMPLES; sample += 1) {
    const at = alongRoute(route, sample / CROSSING_SAMPLES);
    if (boxes.some((box) => Math.abs(at.x - box.x) < NODE_HALF_WIDTH && Math.abs(at.y - box.y) < NODE_HALF_HEIGHT)) {
      return true;
    }
  }
  return false;
}

/**
 * The exchange's name, in open canvas rather than on top of a box.
 *
 * The name used to be set beside the middle of the arrow, which for two boxes standing
 * forty units apart put it squarely across both of them. It now goes into whichever of
 * the three empty bands the hop belongs to: outside the row for a hop along one row,
 * in the gap between the rows for a hop between them, and beside the lane for a hop
 * that detoured. All three are places the diagram never draws a box, so the name and
 * the picture cannot be read on top of each other whatever the label says.
 *
 * The anchor is the middle in every case, and the point is kept away from the frame's
 * edges, so a long name grows into empty space rather than off the canvas.
 */
function arrowLabel(
  document_: Document,
  step: ReplayStep,
  route: readonly Point[],
  from: Point,
  to: Point,
  stopRatio: number,
): SVGElement {
  const at = labelPoint(route, from, to, stopRatio);
  const label = document_.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'replay-arrow-label');
  label.setAttribute('data-arrow-label', 'true');
  label.setAttribute('data-step-index', String(step.index));
  label.setAttribute('data-label-emphasis', emphasisClass(step.outcome, step.phase));
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('x', String(at.x));
  label.setAttribute('y', String(at.y));
  label.textContent = step.label;
  return label;
}

/**
 * Halfway along the part of the route the dot actually travels, not halfway along the
 * whole of it.
 *
 * The two are the same for a step that arrives. For one that is refused they are not,
 * and the difference is what keeps the name off the stop mark: the mark is drawn where
 * the movement ended, and a name centred on the whole route landed on top of it.
 */
function labelPoint(route: readonly Point[], from: Point, to: Point, stopRatio: number): Point {
  const x = clamp(alongRoute(route, stopRatio / 2).x, LABEL_MARGIN, REPLAY_WIDTH - LABEL_MARGIN);
  if (route.length > 2) {
    // A detour: the name goes beside the lane it runs along, on the far side from the
    // row it left, so the line and the name are never on the same pixels.
    const lane = route[1]!.y;
    return { x, y: lane + (lane > from.y ? LABEL_CLEARANCE : -LABEL_CLEARANCE) };
  }
  if (Math.abs(to.y - from.y) < 1) {
    // Along one row: out of the row entirely, into the band on the far side from the
    // other row. The gap between two neighbours is narrower than any name that would
    // go in it. The extra below the row is the baseline: glyphs hang above it, so a
    // name under a row needs more room than one over it.
    const outward = -inwardFrom(from.y);
    return { x, y: from.y + outward * (NODE_HALF_HEIGHT + LABEL_CLEARANCE) + (outward < 0 ? 0 : 6) };
  }
  // Between the rows: the middle of the line is already in the empty band, and the
  // name sits just above it.
  return { x, y: (from.y + to.y) / 2 - LABEL_CLEARANCE / 2 };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Where a refused movement is allowed to come to rest.
 *
 * The plan says how far along the path a refusal stops, and on a short hop that is
 * exactly right. On a long one the same fraction can still put the stop mark on top of
 * a box that had nothing to do with the refusal, which reads as "that service turned it
 * down". So the mark is walked back until it is clear of every box except the one the
 * movement left.
 *
 * A box the replay is not showing cannot mislead anyone, so a hidden one is ignored.
 */
function clearStopRatio(root: HTMLElement, step: ReplayStep, route: readonly Point[]): number {
  const others = otherBoxes(root, [step.from]);
  const clear = (ratio: number): boolean => {
    const at = alongRoute(route, ratio);
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
 * Where a straight line between two box centres meets the first box's edge.
 *
 * Called for both ends. Ending at the centre would draw every arrow underneath the box
 * it points at, and starting at one would draw it underneath the box it left — which is
 * the overlap that made the picture hard to read.
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

/**
 * A point a given fraction of the way along the route, measured by length.
 *
 * By length rather than by corner, because `offset-distance` — which is what actually
 * moves the dot — is a percentage of the path's length. Measuring the stop mark any
 * other way would put the mark somewhere the dot never stops.
 */
function alongRoute(route: readonly Point[], ratio: number): Point {
  const lengths = route.slice(1).map((point, index) => distance(route[index]!, point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return route[0] ?? { x: 0, y: 0 };
  let travelled = clamp(ratio, 0, 1) * total;
  for (const [index, length] of lengths.entries()) {
    if (travelled <= length || index === lengths.length - 1) {
      return between(route[index]!, route[index + 1]!, length === 0 ? 0 : travelled / length);
    }
    travelled -= length;
  }
  return route[route.length - 1]!;
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function between(from: Point, to: Point, ratio: number): Point {
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function pathOf(route: readonly Point[]): string {
  const [first, ...rest] = route;
  return [`M ${round(first!.x)} ${round(first!.y)}`, ...rest.map((point) => `L ${round(point.x)} ${round(point.y)}`)].join(' ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The recorded instants, shown in the reader's own clock.
 *
 * Every `<time>` on the page is served with the instant as it was recorded, in UTC,
 * which is what the record is. A person in Tokyo reading `09:00Z` beside something
 * they did at six in the evening concludes the order is wrong. The text is re-set to
 * the same instant in the browser's zone; the `datetime` attribute keeps the recorded
 * value, and the original is left as a tooltip. Nothing about the order changes.
 */
export function showLocalTimes(root: { querySelectorAll(selector: string): ArrayLike<Element> }): void {
  for (const element of Array.from(root.querySelectorAll('[datetime]'))) {
    const recorded = element.getAttribute('datetime') ?? '';
    const millis = Date.parse(recorded);
    if (!Number.isFinite(millis)) continue;
    try {
      element.setAttribute('title', recorded);
      element.textContent = new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(millis));
    } catch {
      // A browser without Intl keeps the recorded text, which is still correct.
    }
  }
}
