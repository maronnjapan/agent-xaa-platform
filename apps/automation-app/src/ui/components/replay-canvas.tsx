import type { CSSProperties } from 'react';
import { motion } from 'motion/react';
import { emphasisClass } from '../replay/emphasis.js';
import { REPLAY_MOTION_MS } from '../replay/config.js';
import type { ReplayFrame } from '../replay/geometry.js';
import { NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_NODES, REPLAY_VIEWBOX } from '../replay/nodes.js';
import { labelOf } from '../roles.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';

export const REPLAY_LEGEND_CAPTION = 'この図の見方';

/**
 * How to read the picture, written next to the picture.
 *
 * A person who has not read docs 05 sees eight boxes and a moving dot. These lines are
 * what turn that into a claim they can check — and the fifth one is the whole
 * demonstration: a refusal is an arrow that stops, and nothing else on the canvas
 * looks like that.
 */
export const REPLAY_LEGEND: readonly string[] = [
  '上の段は人と、権限を決める側です。下の段は Agent と、Agent が触るリソースです。',
  '箱の名前の下に、その箱が何をするところかを書いています。押すと、もう少し詳しい説明が出ます。',
  '丸は1回のやり取りです。出どころから相手へ動き、矢印のそばにそのやり取りの名前が出ます。',
  '図に出るのは、いま動いている1回分だけです。次へ進むと前の矢印と文字は消えます。',
  '止められたやり取りは、相手に届く手前で止まります。届かなかった箱は点線のままです。',
  '箱の中だけで起きたこと（判断や登録）は、矢印を出さずにその箱を光らせます。',
  '図の右（画面が狭いときは下）に、その手で Agent が何を読み、何を考え、何を決め、何を確かめたかが出ます。',
  '起きたことの全部は、図の下の一覧に順番どおり残ります。再生中の行が強調されます。',
  'この処理に出てこなかった箱は表示しません。出ている箱が、関わったものの全部です。',
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
  total: number;
  controls?: ReplayControls;
  /** Which box's description the person opened, if any. */
  openNode?: string | null;
  onOpenNode?: (id: string | null) => void;
}

/** A CSS custom property, which React's style type does not name. */
type MotionStyle = CSSProperties & Record<'--motion-ms' | '--stop-ratio', string>;

/**
 * The fixed diagram, with the boxes this task did not involve marked hidden rather
 * than removed.
 *
 * Keeping every node in the DOM means the layout is identical across tasks: the
 * Resource API is always bottom-right, whether or not the agent reached it. That is
 * what lets a person compare two replays, and what makes `data-reached="false"` on a
 * particular box meaningful.
 *
 * The caption under the picture is where the words go while it moves. A dot that
 * travels between two boxes says only that something went somewhere; the caption names
 * the two boxes, the exchange, and the publisher's own sentence about it. Every word in
 * it comes off the event, never composed (RULE-54).
 *
 * It holds the current step and only the current step, and so does the canvas. What
 * did happen, in order and in full, is the written log below — server-rendered from
 * the same events, complete, and never wiped by the picture.
 *
 * The controls exist because a replay that only ran once, start to finish, at a fixed
 * pace, is a thing you watch rather than a thing you read. A step that says something
 * surprising is the step you want to stop on.
 */
export function ReplayCanvas(props: ReplayCanvasProps): Element {
  const frame = props.frame ?? null;
  const step = frame?.step ?? null;
  const emphasis = step ? emphasisClass(step.outcome, step.phase) : '';
  const motionStyle: MotionStyle = {
    '--motion-ms': `${REPLAY_MOTION_MS}ms`,
    '--stop-ratio': String(frame?.stopRatio ?? 1),
  };
  return (
    <div
      className="replay"
      data-task-id={props.taskId}
      data-replay-key={props.taskKey ?? props.taskId}
      data-replay-state={props.state}
    >
      {props.simulated ? <SimulatedBadge position="canvas" /> : null}
      <div className="replay-controls" data-replay-controls="true">
        <button type="button" data-action="replay-play" onClick={props.controls?.play}>再生</button>
        <button type="button" data-action="replay-pause" onClick={props.controls?.pause}>一時停止</button>
        <button type="button" data-action="replay-step" onClick={props.controls?.next}>次へ</button>
        <button type="button" data-action="replay-restart" onClick={props.controls?.restart}>最初から</button>
        <span className="replay-progress" data-field="replay-progress">
          {step ? `${step.index + 1} / ${props.total}` : ''}
        </span>
        <span className="replay-track" aria-hidden="true">
          <motion.span
            className="replay-track-fill"
            initial={false}
            animate={{ scaleX: step && props.total > 0 ? (step.index + 1) / props.total : 0 }}
            transition={{ type: 'spring', stiffness: 160, damping: 24 }}
          />
        </span>
      </div>
      <svg viewBox={REPLAY_VIEWBOX} className="replay-canvas" role="img" aria-label="処理の再生">
        {/*
          * The movement layer sits before the boxes, so the boxes paint over it. An
          * arrow runs edge to edge and detours around anything in between, so it should
          * not reach a box at all — this order is what keeps that true when a hidden box
          * is shown again, or a coordinate is changed, rather than leaving the picture
          * to depend on the routing being perfect.
          */}
        <g className="replay-arrows" data-arrows="true">
          {frame && frame.path !== ''
            ? <path key={frame.step.index} className="replay-arrow" data-step-index={String(frame.step.index)} d={frame.path} />
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
            aria-label={`${node.label}：${node.role}`}
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
            <text className="node-label" textAnchor="middle" dy="-2">{node.label}</text>
            <text className="node-role" textAnchor="middle" dy="15">{node.role}</text>
          </g>
        ))}
        {/*
          * The travelling dot, the arrow's name and the refusal's mark go in front, for
          * the opposite reason: adjacent boxes are close enough that most of a
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
          <span className="caption-step" data-field="caption-step">{step ? `${step.index + 1} / ${props.total}` : ''}</span>
          <span className="caption-route" data-field="caption-route">{step ? routeOf(step.from, step.to, step.kind) : ''}</span>
          <span className="caption-label" data-field="caption-label">{step?.label ?? ''}</span>
        </p>
        <p className="caption-message" data-field="caption-message">{step ? step.message : REPLAY_CAPTION_IDLE}</p>
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
  const left = from === null ? '' : labelOf(from);
  const right = to === null ? '' : labelOf(to);
  if (kind === 'move') return `${left} → ${right}`;
  return left || right;
}
