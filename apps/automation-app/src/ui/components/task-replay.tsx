import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActivityEvent } from '@xaa/contracts';
import { REPLAY_STEP_MS } from '../replay/config.js';
import { buildFrame } from '../replay/geometry.js';
import { nodeIdFor, visibleNodeIds } from '../replay/nodes.js';
import { buildReplayPlan, type ReplayEvent } from '../replay/plan.js';
import { thinkingByEvent } from '../replay/thinking.js';
import { roleOf } from '../roles.js';
import { RoleCard } from './cast-panel.js';
import { EventLog, type LogEvent } from './event-log.js';
import { ReplayCanvas, type ReplayControls } from './replay-canvas.js';
import { ThinkingPanel } from './thinking-panel.js';
import type { Element } from '../element.js';

type ReplayState = 'idle' | 'playing' | 'paused' | 'finished';

/** Nothing has played yet. Distinct from step 0, which has. */
const NOTHING_PLAYED = -1;

/**
 * One finished task: the picture, what the agent was thinking on the step the picture
 * is on, and the whole of it in writing underneath.
 *
 * The three read one state. Before this was React they read three: the server rendered
 * the log, a script drew the canvas by hand, and a second script marked the log rows —
 * so which row was current and which step was drawn were two answers that had to be
 * kept in step by hand. Here the step index is held once, and the canvas, the panel and
 * the log are all rendered from it.
 *
 * The server renders it with nothing played, which is exactly what a person sees before
 * they press 再生 — so the markup a browser is handed is the markup React would have
 * produced, and hydration attaches the buttons rather than replacing the page.
 *
 * Nothing plays on its own, and nothing loops. A replay that restarted by itself would
 * make a viewer doubt what they just saw, and one that started on load would take the
 * decision to watch away from them.
 */
export function TaskReplay(props: {
  taskId: string;
  taskKey: string;
  events: readonly ActivityEvent[];
  logEvents: readonly LogEvent[];
  simulated: boolean;
}): Element {
  const plan = useMemo(() => buildReplayPlan(props.events as readonly ReplayEvent[], nodeIdFor), [props.events]);
  const visible = useMemo(() => visibleNodeIds(props.events), [props.events]);
  const thinking = useMemo(() => thinkingByEvent(props.events), [props.events]);

  const [index, setIndex] = useState(NOTHING_PLAYED);
  const [state, setState] = useState<ReplayState>('idle');
  const [openNode, setOpenNode] = useState<string | null>(null);

  const last = plan.length - 1;
  const settle = useCallback((next: number, playing: boolean): void => {
    setIndex(next);
    setState(next >= last ? 'finished' : (playing ? 'playing' : 'paused'));
  }, [last]);

  useEffect(() => {
    if (state !== 'playing') return undefined;
    const timer = setTimeout(() => settle(index + 1, true), REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [state, index, settle]);

  const controls: ReplayControls = useMemo(() => ({
    play: () => { if (state !== 'finished') settle(Math.max(index, 0), true); },
    pause: () => setState((current) => (current === 'playing' ? 'paused' : current)),
    next: () => { if (state !== 'finished') settle(Math.min(index + 1, last), false); },
    restart: () => settle(0, true),
  }), [state, index, last, settle]);

  const step = index >= 0 ? plan[index] : undefined;
  const frame = step ? buildFrame(step, visible) : null;
  const currentEventId = step?.eventId ?? null;
  const opened = openNode === null ? null : roleOf(openNode);

  return (
    <div className="task-replay-body" data-task-replay={props.taskKey}>
      <div className="replay-stage">
        <ReplayCanvas
          taskId={props.taskId}
          taskKey={props.taskKey}
          visible={visible}
          simulated={props.simulated}
          state={state}
          frame={frame}
          total={plan.length}
          controls={controls}
          openNode={openNode}
          onOpenNode={setOpenNode}
        />
        <ThinkingPanel
          taskKey={props.taskKey}
          frame={currentEventId === null ? null : thinking.get(currentEventId) ?? null}
        />
      </div>
      {opened
        ? (
          <div className="replay-role-open" data-role-open={opened.id}>
            <RoleCard actor={opened} />
            <button type="button" data-action="close-role" onClick={() => setOpenNode(null)}>閉じる</button>
          </div>
        )
        : null}
      <EventLog
        taskId={props.taskId}
        taskKey={props.taskKey}
        events={props.logEvents}
        currentEventId={currentEventId}
      />
    </div>
  );
}
