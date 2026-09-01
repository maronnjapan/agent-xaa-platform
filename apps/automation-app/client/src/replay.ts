import { buildReplayPlan, isFinished, type ReplayEvent, type ReplayStep } from './replay-plan.js';
import { REPLAY_STEP_MS } from './replay-config.js';
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
 */
export function playReplay(root: HTMLElement, events: readonly ReplayEvent[]): () => void {
  const plan = buildReplayPlan(events, (source) => SOURCE_TO_NODE[source] ?? null);
  const messages = root.querySelector('[data-messages]');
  const banner = root.querySelector('[data-banner]');
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const step = (): void => {
    const current = plan[index];
    if (!current) return;
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
    if (isFinished(plan, index)) {
      root.setAttribute('data-replay-state', 'finished');
      return;
    }
    index += 1;
    timer = setTimeout(step, REPLAY_STEP_MS);
  };

  resetNodes(root);
  root.setAttribute('data-replay-state', 'playing');
  step();
  return () => { if (timer !== undefined) clearTimeout(timer); };
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
  const stop = edgeOf(finish, start);
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
  dot.style.setProperty('--stop-ratio', String(step.stopRatio));
  arrows.appendChild(dot);

  if (step.blocked) arrows.appendChild(stopMark(document_, pointAt(start, stop, step.stopRatio), emphasis));

  const target = step.to === null ? null : root.querySelector(`[data-node="${step.to}"]`);
  // A blocked step never arrives, so the destination stays explicitly unreached.
  if (target) target.setAttribute('data-reached', step.blocked ? 'false' : 'true');
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
