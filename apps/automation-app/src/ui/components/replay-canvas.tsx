import { NODE_HALF_HEIGHT, NODE_HALF_WIDTH, REPLAY_NODES, REPLAY_VIEWBOX, visibleNodeIds } from '../replay/nodes.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';


interface CanvasEvent { source: string; detail?: Record<string, unknown> }

/**
 * The fixed diagram, with the boxes this task did not involve marked hidden rather
 * than removed.
 *
 * Keeping every node in the DOM means the layout is identical across tasks: the
 * Resource API is always bottom-right, whether or not the agent reached it. That is
 * what lets a person compare two replays, and what makes `data-reached="false"` on a
 * particular box meaningful.
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
      <svg viewBox={REPLAY_VIEWBOX} class="replay-canvas" role="img" aria-label="処理の再生">
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
            <text text-anchor="middle" dy="5">{node.label}</text>
          </g>
        ))}
        <g class="replay-arrows" data-arrows="true" />
        <text class="replay-banner" data-banner="true" x="360" y="150" text-anchor="middle" />
      </svg>
      <ol class="replay-messages" data-messages="true" />
    </div>
  );
}
