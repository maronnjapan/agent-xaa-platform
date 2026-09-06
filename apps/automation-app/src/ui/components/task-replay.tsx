import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityEvent } from '@xaa/contracts';
import { REPLAY_STEP_MS } from '../replay/config.js';
import { buildFrame } from '../replay/geometry.js';
import { nodeIdFor, visibleNodeIds } from '../replay/nodes.js';
import { buildReplayPlan, type ReplayEvent } from '../replay/plan.js';
import { thinkingByEvent } from '../replay/thinking.js';
import { roleOf } from '../roles.js';
import { RoleCard } from './cast-panel.js';
import { ReplayCanvas, type ReplayControls } from './replay-canvas.js';
import { ThinkingPanel } from './thinking-panel.js';
import type { Element } from '../element.js';

type ReplayState = 'idle' | 'playing' | 'paused' | 'finished';

/** Nothing has played yet. Distinct from step 0, which has. */
const NOTHING_PLAYED = -1;

/**
 * One finished task as a moving picture: the diagram, and what the agent was thinking
 * on the step the diagram is on.
 *
 * The written account of the same task is no longer underneath it. The pictures of one
 * agent's tasks are shown one after another, and the accounts of all of them follow
 * (see `RunReplay`), so a person watching two tasks in a row is not made to scroll past
 * a hundred lines of log between them. Which row of that account the picture has
 * reached is still one answer rather than two: this holds the step index and reports
 * the event it is on, and the log renders from what it reports.
 *
 * The server renders it with nothing played, which is exactly what a person sees before
 * they press 再生 — so the markup a browser is handed is the markup React would have
 * produced, and hydration attaches the buttons rather than replacing the page.
 *
 * Nothing plays on its own, and nothing loops. A replay that restarted by itself would
 * make a viewer doubt what they just saw, and one that started on load would take the
 * decision to watch away from them.
 */
export function TaskStage(props: {
  taskId: string;
  taskKey: string;
  events: readonly ActivityEvent[];
  simulated: boolean;
  /** Told which event the picture is on, so the account below can mark that row. */
  onCurrentEvent?: (eventId: string | null) => void;
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

  /*
   * Reported from an effect rather than during the render that moved the step, because
   * the listener is a second component's state: setting it while this one is rendering
   * is React telling itself to render again mid-render. Held in a ref so a parent that
   * passes a fresh closure each time does not restart the reporting.
   */
  const report = useRef(props.onCurrentEvent);
  useEffect(() => { report.current = props.onCurrentEvent; });
  useEffect(() => { report.current?.(currentEventId); }, [currentEventId]);

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
    </div>
  );
}
