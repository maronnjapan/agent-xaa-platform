import type { ActivityRecord } from '@xaa/contracts';
import { NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_NODES, REPLAY_VIEWBOX, visibleNodeIds } from '../replay/nodes.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';


interface CanvasEvent { source: string; detail?: Record<string, unknown>; record?: ActivityRecord }

export const REPLAY_LEGEND_CAPTION = 'この図の見方';

/**
 * How to read the picture, written next to the picture.
 *
 * A person who has not read docs 05 sees eight boxes and a moving dot. These four
 * lines are what turn that into a claim they can check — and the third one is the
 * whole demonstration: a refusal is an arrow that stops, and nothing else on the
 * canvas looks like that.
 */
export const REPLAY_LEGEND: readonly string[] = [
  '上の段は人と、権限を決める側です。下の段は Agent と、Agent が触るリソースです。',
  '丸は1回のやり取りです。出どころから相手へ動き、届いたところでその説明が出ます。',
  '止められたやり取りは、相手に届く手前で止まります。届かなかった箱は点線のままです。',
  'この処理に出てこなかった箱は表示しません。出ている箱が、関わったものの全部です。',
];

/**
 * The fixed diagram, with the boxes this task did not involve marked hidden rather
 * than removed.
 *
 * Keeping every node in the DOM means the layout is identical across tasks: the
 * Resource API is always bottom-right, whether or not the agent reached it. That is
 * what lets a person compare two replays, and what makes `data-reached="false"` on a
 * particular box meaningful.
 *
 * The controls exist because a replay that only ran once, start to finish, at a fixed
 * pace, is a thing you watch rather than a thing you read. A step that says something
 * surprising is the step you want to stop on.
 */
export function ReplayCanvas(props: {
  taskId: string;
  events: readonly CanvasEvent[];
  simulated?: boolean;
}): Element {
  const visible = visibleNodeIds(props.events);
  return (
    <div class="replay" data-task-id={props.taskId} data-replay-state="idle">
      {props.simulated ? <SimulatedBadge position="canvas" /> : null}
      <div class="replay-controls" data-replay-controls="true">
        <button type="button" data-action="replay-play">再生</button>
        <button type="button" data-action="replay-pause">一時停止</button>
        <button type="button" data-action="replay-step">次へ</button>
        <button type="button" data-action="replay-restart">最初から</button>
        <span class="replay-progress" data-field="replay-progress" />
      </div>
      <svg viewBox={REPLAY_VIEWBOX} class="replay-canvas" role="img" aria-label="処理の再生">
        {/*
          * The movement layer sits before the boxes, so the boxes paint over it.
          * An arrow runs from one centre to the edge of the next, and with the layers
          * the other way round every line was drawn straight through the label of the
          * box it started from.
          */}
        <g class="replay-arrows" data-arrows="true" />
        {REPLAY_NODES.map((node) => (
          <g
            class="replay-node"
            data-node={node.id}
            data-reached="false"
            data-x={String(node.x)}
            data-y={String(node.y)}
            transform={`translate(${node.x},${node.y})`}
            {...(visible.has(node.id) ? {} : { hidden: true })}
          >
            <rect
              x={String(-NODE_HALF_WIDTH)}
              y={String(-NODE_HALF_HEIGHT)}
              width={String(NODE_HALF_WIDTH * 2)}
              height={String(NODE_HALF_HEIGHT * 2)}
              rx="6"
            />
            <text class="node-label" text-anchor="middle" dy="-2">{node.label}</text>
            <text class="node-role" text-anchor="middle" dy="15">{node.role}</text>
          </g>
        ))}
        {/*
          * The travelling dots go in front, for the opposite reason: adjacent boxes are
          * close enough that most of a centre-to-edge path lies under the box it starts
          * from, and a dot behind the boxes would be out of sight for most of its trip.
          */}
        <g class="replay-dots" data-dots="true" />
        <text class="replay-banner" data-banner="true" x="360" y="150" text-anchor="middle" />
      </svg>
      <ol class="replay-messages" data-messages="true" />
      <details class="replay-legend" data-legend="true">
        <summary>{REPLAY_LEGEND_CAPTION}</summary>
        <ul>
          {REPLAY_LEGEND.map((line) => <li>{line}</li>)}
        </ul>
      </details>
    </div>
  );
}
