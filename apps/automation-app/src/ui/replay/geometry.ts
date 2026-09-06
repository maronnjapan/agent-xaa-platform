import { MIN_STOP_RATIO, STOP_CLEARANCE, STOP_RATIO_STEP } from './config.js';
import { NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_NODES, REPLAY_WIDTH } from './nodes.js';
import type { ReplayStep } from './plan.js';

/**
 * Where every line, dot, stop mark and name of one step goes, worked out from numbers
 * alone.
 *
 * This used to be inside the browser script, reading coordinates back out of the DOM
 * it had just written. That made the picture's one geometric promise — a line and a
 * name are about the two boxes at the ends of the arrow and about no other box —
 * checkable only by building a fake document first. It is arithmetic over eight fixed
 * coordinates, so it is arithmetic here: the React canvas renders what these functions
 * return, and the tests call them directly.
 *
 * Nothing in this file reads an event. It is handed a step the plan already built and
 * the set of boxes this task involves, and answers where to draw. What any of it means
 * is the publisher's to say (RULE-54).
 */

export interface Point { x: number; y: number }

/**
 * How far outside a row a detour runs, and how far outside a row a label sits.
 *
 * Both are measured from the edge of a box rather than from its centre, so they stay
 * correct if a box ever changes size. The rows are 160 apart and 60 tall, which leaves
 * a hundred units of empty canvas between them and enough above and below for one line
 * of text — those three bands are the only places anything is allowed to be drawn that
 * is not a box.
 */
const LANE_CLEARANCE = 60;
const LABEL_CLEARANCE = 12;

/** How far a name is kept from the left and right edges of the frame. */
const LABEL_MARGIN = 110;

const CROSSING_SAMPLES = 60;

/** How a box is drawn while a step is the current one. */
export type NodeRole = 'from' | 'to' | 'self' | '';

export interface ReplayFrame {
  step: ReplayStep;
  /** `move` draws a path, `self` a ring, `banner` a line of text and nothing else. */
  kind: ReplayStep['kind'];
  /** The corners of the path, in order; empty for a step that moves nothing. */
  route: readonly Point[];
  /** The same corners as an SVG `d`, which is also what the dot's `offset-path` is. */
  path: string;
  /** How far along the path the dot travels: 1 for a step that arrived. */
  stopRatio: number;
  /** Where the refusal's mark goes, for a blocked step. */
  stopAt: Point | null;
  /** Where the exchange's name goes, in one of the three bands with no box in it. */
  labelAt: Point | null;
  /** The box a `self` step happened inside. */
  pulseAt: Point | null;
  /** How every box is drawn: two lit for a move, one for a self step, none for a banner. */
  roles: Readonly<Record<string, NodeRole>>;
  /** The box a movement arrived at, and so may be marked reached. */
  reached: string | null;
  /** The box a movement set off for and never arrived at. */
  unreached: string | null;
}

/** Every visible box the step is not about; the ones a line must not be drawn over. */
function obstacles(visible: ReadonlySet<string>, involved: readonly (string | null)[]): Point[] {
  return REPLAY_NODES
    .filter((node) => visible.has(node.id) && !involved.includes(node.id))
    .map((node) => ({ x: node.x, y: node.y }));
}

function centreOf(id: string | null): Point | null {
  const node = id === null ? undefined : REPLAY_NODES.find((candidate) => candidate.id === id);
  return node ? { x: node.x, y: node.y } : null;
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

/**
 * Where a straight line between two box centres meets the first box's edge.
 *
 * Called for both ends. Ending at the centre would draw every arrow underneath the box
 * it points at, and starting at one would draw it underneath the box it left — which is
 * the overlap that made the picture hard to read.
 */
export function edgeOf(target: Point, from: Point): Point {
  const dx = from.x - target.x;
  const dy = from.y - target.y;
  if (dx === 0 && dy === 0) return target;
  const horizontal = dx === 0 ? Number.POSITIVE_INFINITY : NODE_HALF_WIDTH / Math.abs(dx);
  const vertical = dy === 0 ? Number.POSITIVE_INFINITY : NODE_HALF_HEIGHT / Math.abs(dy);
  const scale = Math.min(1, horizontal, vertical);
  return { x: target.x + dx * scale, y: target.y + dy * scale };
}

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
 */
export function routeAround(
  from: Point,
  to: Point,
  visible: ReadonlySet<string>,
  involved: readonly (string | null)[],
): Point[] {
  const direct = [edgeOf(from, to), edgeOf(to, from)];
  if (!crossesAny(direct, obstacles(visible, involved))) return direct;
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
export function clearStopRatio(
  route: readonly Point[],
  start: number,
  visible: ReadonlySet<string>,
  involved: readonly (string | null)[],
): number {
  const others = obstacles(visible, involved);
  const clear = (ratio: number): boolean => {
    const at = alongRoute(route, ratio);
    return others.every((node) => Math.abs(at.x - node.x) > NODE_HALF_WIDTH + STOP_CLEARANCE
      || Math.abs(at.y - node.y) > NODE_HALF_HEIGHT + STOP_CLEARANCE);
  };
  for (let ratio = start; ratio > MIN_STOP_RATIO; ratio -= STOP_RATIO_STEP) {
    if (clear(ratio)) return Math.round(ratio * 100) / 100;
  }
  return MIN_STOP_RATIO;
}

/**
 * The exchange's name, in open canvas rather than on top of a box.
 *
 * The name goes into whichever of the three empty bands the hop belongs to: outside
 * the row for a hop along one row, in the gap between the rows for a hop between them,
 * and beside the lane for a hop that detoured. All three are places the diagram never
 * draws a box, so the name and the picture cannot be read on top of each other whatever
 * the label says.
 *
 * It is halfway along the part of the route the dot actually travels, not halfway along
 * the whole of it. The two are the same for a step that arrives. For one that is
 * refused they are not, and the difference is what keeps the name off the stop mark.
 */
export function labelPoint(route: readonly Point[], from: Point, to: Point, stopRatio: number): Point {
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

/**
 * A point a given fraction of the way along the route, measured by length.
 *
 * By length rather than by corner, because `offset-distance` — which is what actually
 * moves the dot — is a percentage of the path's length. Measuring the stop mark any
 * other way would put the mark somewhere the dot never stops.
 */
export function alongRoute(route: readonly Point[], ratio: number): Point {
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

export function pathOf(route: readonly Point[]): string {
  const [first, ...rest] = route;
  if (!first) return '';
  return [`M ${round(first.x)} ${round(first.y)}`, ...rest.map((point) => `L ${round(point.x)} ${round(point.y)}`)].join(' ');
}

/**
 * One step, resolved into everything the canvas has to draw for it.
 *
 * A frame holds this step and only this step. What the step before drew is not in it,
 * because a picture that accumulated its arrows answered "what is happening now" with
 * eight overlapping lines. What did happen, in order and in full, is the written log
 * beside the picture.
 */
export function buildFrame(step: ReplayStep, visible: ReadonlySet<string>): ReplayFrame {
  const roles: Record<string, NodeRole> = {};
  for (const node of REPLAY_NODES) roles[node.id] = '';

  const from = centreOf(step.from);
  const to = centreOf(step.to);
  const empty: ReplayFrame = {
    step, kind: step.kind, route: [], path: '', stopRatio: step.stopRatio,
    stopAt: null, labelAt: null, pulseAt: null, roles, reached: null, unreached: null,
  };

  if (step.kind === 'banner' || (!from && !to)) return empty;

  if (step.kind === 'self' || !from || !to) {
    const at = from ?? to;
    const id = step.from ?? step.to;
    if (id !== null) roles[id] = 'self';
    return { ...empty, kind: 'self', pulseAt: at, ...(step.from === null ? {} : { reached: step.from }) };
  }

  if (step.from !== null) roles[step.from] = 'from';
  if (step.to !== null) roles[step.to] = 'to';
  const route = routeAround(from, to, visible, [step.from, step.to]);
  const stopRatio = step.blocked ? clearStopRatio(route, step.stopRatio, visible, [step.from]) : step.stopRatio;
  return {
    step,
    kind: 'move',
    route,
    path: pathOf(route),
    stopRatio,
    stopAt: step.blocked ? alongRoute(route, stopRatio) : null,
    labelAt: step.label === '' ? null : labelPoint(route, from, to, stopRatio),
    pulseAt: null,
    roles,
    reached: step.blocked ? null : step.to,
    unreached: step.blocked ? step.to : null,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

function between(from: Point, to: Point, ratio: number): Point {
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
