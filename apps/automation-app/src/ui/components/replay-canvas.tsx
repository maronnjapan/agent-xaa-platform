import type { CSSProperties, ReactNode } from 'react';
import { motion } from 'motion/react';
import { emphasisClass } from '../replay/emphasis.js';
import { REPLAY_MOTION_MS } from '../replay/config.js';
import { ARROWHEAD_HALF_WIDTH, ARROWHEAD_LENGTH, type ReplayFrame } from '../replay/geometry.js';
import { NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_LANES, REPLAY_NODES, REPLAY_VIEWBOX } from '../replay/nodes.js';
import { nameOf } from '../roles.js';
import { CAST_DOES_NOT } from './cast-panel.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';

export const REPLAY_LEGEND_CAPTION = 'この図の見方';

/**
 * How to read the picture, written next to the picture.
 *
 * A person who has not read docs 05 sees eight boxes and a moving dot. These lines are
 * what turn that into a claim they can check — and the third one is the whole
 * demonstration: a refusal is an arrow that stops, and nothing else on the canvas
 * looks like that.
 *
 * Six lines, one fact each: the bands, the moving line and its head, the refusal, the
 * trail of a call, a step inside one box, and the boxes themselves. Each describes a
 * thing the picture draws, and none of them describes an event.
 */
export const REPLAY_LEGEND: readonly string[] = [
  '箱は4つの帯に分かれ、帯の左端にその側の名前があります。上の段が人と決める側、下の段が動く側とデータを持つ側です。',
  '丸は1回のやり取りです。線は丸と一緒に伸び、矢の先が届いた側です。図に出るのは、いま動いている1回分だけです。',
  '止められたやり取りは、相手に届く手前で止まり、届かなかった残りは点線になります。',
  '同じできごとの中の前のやり取りは、薄い線で残ります。1回の Tool 呼び出しには往復が4つあります。',
  '箱の中だけで起きたことは、矢印を出さずにその箱が光ります。',
  '箱を押すと説明が出ます。出ていない箱は、この処理に関わっていません。',
];

export const REPLAY_CAPTION_IDLE = '再生を押すと、ここに1手ずつ説明が出ます。';

export interface ReplayControls {
  play(): void;
  pause(): void;
  next(): void;
  restart(): void;
}

export interface ReplayCanvasProps {
  taskId: string;
  taskKey?: string;
  /** Which boxes this task involved; the rest are hidden, not removed. */
  visible: ReadonlySet<string>;
  simulated?: boolean;
  /** `idle` before anything has played; the server always renders `idle`. */
  state: 'idle' | 'playing' | 'paused' | 'finished';
  /** The current step, resolved into geometry. Absent before the first step. */
  frame?: ReplayFrame | null;
  /** The earlier exchanges of the same event, drawn faintly under the current one. */
  trail?: readonly ReplayFrame[];
  total: number;
  controls?: ReplayControls;
  /**
   * How long a step's movement takes. The ordinary length unless a story is being
   * played at another pace, in which case the motion shortens with the step so the dot
   * still lands before the step is up.
   */
  motionMs?: number;
  /** Which box's description the person opened, if any. */
  openNode?: string | null;
  onOpenNode?: (id: string | null) => void;
  /**
   * Where the step stands, as the count and the bar say it: within a chapter, when a
   * story is being played chapter by chapter, and across every step otherwise.
   */
  position?: { at: number; of: number } | null;
  /** More controls for the same bar: a story's pace, the whole-screen switch. */
  tools?: ReactNode;
}

/** A CSS custom property, which React's style type does not name. */
type MotionStyle = CSSProperties & Record<'--motion-ms' | '--stop-ratio', string>;
type DrawStyle = MotionStyle & Record<'--path-length', string>;

/**
 * The fixed diagram, with the boxes this task did not involve marked hidden rather
 * than removed.
 *
 * Keeping every node in the DOM means the layout is identical across tasks: the
 * Resource API is always bottom-right, whether or not the agent reached it. That is
 * what lets a person compare two replays, and what makes `data-reached="false"` on a
 * particular box meaningful.
 *
 * The picture is meant to be read on its own, by someone who is watching it rather
 * than reading beside it. So the boxes sit in named bands — who decides, who acts, who
 * holds the data — and a movement is drawn as a line that grows with the dot and ends
 * in an arrowhead when the dot lands, or in a stop mark with the rest of the way
 * dotted when it was refused. The earlier legs of the same event stay faintly in
 * place, so a tool call's four exchanges read as one journey. A box being introduced
 * is lit alone, with its name and what it is like written under it.
 *
 * The caption under the picture is where the words go while it moves. A dot that
 * travels between two boxes says only that something went somewhere; the caption names
 * the two boxes, the exchange, and the publisher's own sentence about it — which
 * appears when the dot lands, not before. Every word in it comes off the event, never
 * composed (RULE-54).
 *
 * It holds the current step and only the current step, and so does the canvas. What
 * did happen, in order and in full, is the written account on the viewer's other face
 * — server-rendered from the same events, complete, and never wiped by the picture.
 *
 * The controls exist because a replay that only ran once, start to finish, at a fixed
 * pace, is a thing you watch rather than a thing you read. A step that says something
 * surprising is the step you want to stop on.
 */
export function ReplayCanvas(props: ReplayCanvasProps): Element {
  const frame = props.frame ?? null;
  const step = frame?.step ?? null;
  const cast = step?.cast ?? null;
  const emphasis = step ? emphasisClass(step.outcome, step.phase) : '';
  const motionMs = props.motionMs ?? REPLAY_MOTION_MS;
  const motionStyle: MotionStyle = {
    '--motion-ms': `${motionMs}ms`,
    '--stop-ratio': String(frame?.stopRatio ?? 1),
  };
  const drawStyle: DrawStyle = { ...motionStyle, '--path-length': String(Math.ceil(frame?.solidLength ?? 0)) };
  const position = props.position ?? (step ? { at: step.index + 1, of: props.total } : null);
  const count = position ? `${position.at} / ${position.of}` : '';
  return (
    <div
      className="replay"
      data-task-id={props.taskId}
      data-replay-key={props.taskKey ?? props.taskId}
      data-replay-state={props.state}
      data-replay-mode={cast ? 'cast' : 'story'}
    >
      {props.simulated ? <SimulatedBadge position="canvas" /> : null}
      <div className="replay-controls" data-replay-controls="true">
        <button type="button" data-action="replay-play" onClick={props.controls?.play}>再生</button>
        <button type="button" data-action="replay-pause" onClick={props.controls?.pause}>一時停止</button>
        <button type="button" data-action="replay-step" onClick={props.controls?.next}>次へ</button>
        <button type="button" data-action="replay-restart" onClick={props.controls?.restart}>最初から</button>
        <span className="replay-progress" data-field="replay-progress">{count}</span>
        <span className="replay-track" aria-hidden="true">
          <motion.span
            className="replay-track-fill"
            initial={false}
            animate={{ scaleX: position && position.of > 0 ? position.at / position.of : 0 }}
            transition={{ type: 'spring', stiffness: 160, damping: 24 }}
          />
        </span>
        {props.tools ? <span className="replay-tools">{props.tools}</span> : null}
      </div>
      <svg viewBox={REPLAY_VIEWBOX} className="replay-canvas" role="img" aria-label="処理の再生">
        {/*
          * The bands first, under everything: each is the ground the boxes of one side
          * stand on, named at its edge. A band none of whose boxes this task involved is
          * hidden with them, so the picture of a tool call does not show an empty
          * 「決める側」.
          */}
        <g className="replay-lanes" data-lanes="true">
          {REPLAY_LANES.map((lane) => (
            <g
              key={lane.lane}
              className="replay-lane"
              data-lane={lane.lane}
              {...(lane.nodes.some((id) => props.visible.has(id)) ? {} : { hidden: true })}
            >
              <rect x={String(lane.x)} y={String(lane.y)} width={String(lane.width)} height={String(lane.height)} rx="10" />
              <text className="lane-caption" x={String(lane.captionAt.x)} y={String(lane.captionAt.y)}>{lane.label}</text>
            </g>
          ))}
        </g>
        {/*
          * The movement layer sits before the boxes, so the boxes paint over it. An
          * arrow runs edge to edge and detours around anything in between, so it should
          * not reach a box at all — this order is what keeps that true when a hidden box
          * is shown again, or a coordinate is changed, rather than leaving the picture
          * to depend on the routing being perfect.
          *
          * The trail is the same event's earlier legs, lines only: no name, no dot, no
          * head. It is what makes four exchanges one call.
          */}
        <g className="replay-trail" data-trail="true">
          {(props.trail ?? []).map((earlier) => (earlier.solidPath === ''
            ? null
            : (
              <path
                key={earlier.step.index}
                className="replay-arrow is-trail"
                data-trail-step={String(earlier.step.index)}
                d={earlier.solidPath}
              />
            )))}
        </g>
        <g className="replay-arrows" data-arrows="true">
          {frame && frame.solidPath !== ''
            ? (
              <path
                key={frame.step.index}
                className="replay-arrow is-live"
                data-step-index={String(frame.step.index)}
                d={frame.solidPath}
                style={drawStyle}
              />
            )
            : null}
          {frame && frame.restPath !== ''
            ? <path key={`rest-${frame.step.index}`} className="replay-arrow is-unreached" data-unreached-path="true" d={frame.restPath} />
            : null}
        </g>
        {REPLAY_NODES.map((node) => (
          <g
            key={node.id}
            className="replay-node"
            data-node={node.id}
            data-reached={reachedOf(node.id, frame)}
            data-active={frame?.roles[node.id] ?? ''}
            data-x={String(node.x)}
            data-y={String(node.y)}
            transform={`translate(${node.x},${node.y})`}
            role="button"
            tabIndex={0}
            aria-label={`${node.actor.name}（${node.label}）：${node.role}`}
            onClick={() => props.onOpenNode?.(props.openNode === node.id ? null : node.id)}
            {...(props.visible.has(node.id) ? {} : { hidden: true })}
          >
            <rect
              x={String(-NODE_HALF_WIDTH)}
              y={String(-NODE_HALF_HEIGHT)}
              width={String(NODE_HALF_WIDTH * 2)}
              height={String(NODE_HALF_HEIGHT * 2)}
              rx="6"
            />
            <title>{`${node.actor.name}（${node.label}）`}</title>
            <text className="node-label" textAnchor="middle" dy="-2">{node.actor.name}</text>
            <text className="node-role" textAnchor="middle" dy="15">{node.role}</text>
          </g>
        ))}
        {/*
          * The travelling dot, the arrow's name, its head and the refusal's mark go in
          * front, for the opposite reason: adjacent boxes are close enough that most of a
          * centre-to-edge path lies under the box it starts from, and a dot behind the
          * boxes would be out of sight for most of its trip.
          */}
        <g className="replay-labels" data-labels="true">
          {frame?.labelAt && step
            ? (
              <text
                key={step.index}
                className="replay-arrow-label"
                data-arrow-label="true"
                data-step-index={String(step.index)}
                data-label-emphasis={emphasis}
                textAnchor="middle"
                x={String(frame.labelAt.x)}
                y={String(frame.labelAt.y)}
              >
                {step.label}
              </text>
            )
            : null}
          {frame?.calloutAt && cast
            ? (
              <g
                key={`cast-${step?.index ?? ''}`}
                className="replay-callout"
                data-callout={cast.id}
                transform={`translate(${frame.calloutAt.x},${frame.calloutAt.y})`}
              >
                <text className="callout-name" textAnchor="middle">{`${cast.name}（${cast.analogy}）`}</text>
                <text className="callout-role" textAnchor="middle" dy="15">{cast.role}</text>
              </g>
            )
            : null}
        </g>
        <g className="replay-dots" data-dots="true">
          {frame && step && frame.kind === 'move' && frame.path !== ''
            ? (
              <circle
                key={step.index}
                className={step.blocked ? 'replay-dot is-blocked' : 'replay-dot'}
                data-step-index={String(step.index)}
                data-from={step.from ?? ''}
                data-to={step.to ?? ''}
                data-emphasis={emphasis}
                {...(step.blocked ? { 'data-blocked': 'true' } : {})}
                r="6"
                style={{ ...motionStyle, offsetPath: `path('${frame.path}')` }}
              />
            )
            : null}
          {frame?.headAt && step
            ? (
              <path
                key={`head-${step.index}`}
                className="replay-arrowhead"
                data-arrowhead="true"
                data-emphasis={emphasis}
                d={`M ${-ARROWHEAD_LENGTH} ${-ARROWHEAD_HALF_WIDTH} L 0 0 L ${-ARROWHEAD_LENGTH} ${ARROWHEAD_HALF_WIDTH} Z`}
                transform={`translate(${frame.headAt.x},${frame.headAt.y}) rotate(${frame.headAt.angle})`}
                style={motionStyle}
              />
            )
            : null}
          {frame?.pulseAt && step
            ? (
              <rect
                key={`pulse-${step.index}`}
                className="replay-pulse"
                data-pulse="true"
                data-step-index={String(step.index)}
                data-pulse-emphasis={emphasis}
                x={String(frame.pulseAt.x - NODE_HALF_WIDTH - 4)}
                y={String(frame.pulseAt.y - NODE_HALF_HEIGHT - 4)}
                width={String(NODE_HALF_WIDTH * 2 + 8)}
                height={String(NODE_HALF_HEIGHT * 2 + 8)}
                rx="9"
                style={motionStyle}
              />
            )
            : null}
          {frame?.stopAt && step
            ? (
              <g
                key={`stop-${step.index}`}
                className="replay-stop"
                data-stop="true"
                data-emphasis={emphasis}
                transform={`translate(${frame.stopAt.x},${frame.stopAt.y})`}
                style={motionStyle}
              >
                <circle r="9" />
                <path d="M -6 -6 L 6 6" />
              </g>
            )
            : null}
        </g>
        <text className="replay-banner" data-banner="true" x="360" y="150" textAnchor="middle">
          {frame?.kind === 'banner' ? frame.step.message : ''}
        </text>
      </svg>
      <div
        className="replay-caption"
        data-caption="true"
        data-caption-state={captionState(props.state, step?.blocked === true)}
        {...(emphasis ? { 'data-caption-emphasis': emphasis } : {})}
      >
        <p className="caption-head">
          <span className="caption-step" data-field="caption-step">{count}</span>
          <span className="caption-route" data-field="caption-route">{step ? routeOf(step.from, step.to, step.kind) : ''}</span>
          <span className="caption-label" data-field="caption-label">{step?.label ?? ''}</span>
        </p>
        {/*
          * Keyed by the step so the sentence is a new element each step and its
          * appearance can be timed to the dot's arrival: the words about an exchange
          * are shown when the exchange has happened (docs 11 §5.2).
          */}
        <p
          key={step ? `message-${step.index}` : 'idle'}
          className="caption-message"
          data-field="caption-message"
          {...(frame?.kind === 'move' ? { 'data-arrives': 'true' } : {})}
          style={motionStyle}
        >
          {step ? step.message : REPLAY_CAPTION_IDLE}
        </p>
        {cast
          ? (
            <p className="caption-message caption-does-not" data-field="caption-does-not">
              <span className="caption-does-not-label">{CAST_DOES_NOT}</span>
              {cast.doesNot}
            </p>
          )
          : null}
      </div>
      <details className="replay-legend" data-legend="true">
        <summary>{REPLAY_LEGEND_CAPTION}</summary>
        <ul>
          {REPLAY_LEGEND.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </details>
    </div>
  );
}

/**
 * Three answers, not two: a box a step arrived at, a box a step set off for and never
 * reached, and a box this step says nothing about.
 *
 * The page is served with every box marked `false`, which is true before anything
 * plays. Once a replay is running the mark means something narrower — "this step set
 * off for here and did not arrive" — and that only reads if the boxes the step never
 * touched carry no verdict at all (RULE-54).
 */
function reachedOf(id: string, frame: ReplayFrame | null): string {
  if (!frame) return 'false';
  if (frame.unreached === id) return 'false';
  return frame.reached === id ? 'true' : '';
}

function captionState(state: ReplayCanvasProps['state'], blocked: boolean): string {
  if (state === 'idle') return 'idle';
  return blocked ? 'blocked' : 'playing';
}

/** The boxes' own names, joined by the diagram's arrow glyph: a route, not a sentence. */
function routeOf(from: string | null, to: string | null, kind: string): string {
  const left = from === null ? '' : nameOf(from);
  const right = to === null ? '' : nameOf(to);
  if (kind === 'move') return `${left} → ${right}`;
  return left || right;
}
