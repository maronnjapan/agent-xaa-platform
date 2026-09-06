import { useCallback, useState } from 'react';
import type { ActivityEvent } from '@xaa/contracts';
import { EventLog, type LogEvent } from './event-log.js';
import { LocalTime } from './local-time.js';
import { TaskStage } from './task-replay.js';
import type { Element } from '../element.js';

export const RUN_STAGES_CAPTION = '動きを見る';
export const RUN_STAGES_NOTE = '「再生」で1手ずつ進みます。「一時停止」で止まり、「次へ」で自分で進められます。';
export const RUN_RECORD_CAPTION = 'やったこと';
export const RUN_RECORD_NOTE = '同じ内容を、起きた順に文章で並べています。再生中の行が強調されます。';

export interface ReplayTask {
  taskId: string;
  taskKey: string;
  purpose: string;
  completedAt: string;
  events: readonly ActivityEvent[];
  logEvents: readonly LogEvent[];
  simulated: boolean;
}

/**
 * One agent's finished tasks: every picture first, then every account.
 *
 * They used to alternate — a picture, its hundred-line account, the next picture — so
 * two tasks of the same agent were never on screen together, and a person who wanted
 * to watch the run through had to scroll past the writing between each pair. The
 * pictures are short and belong side by side; the writing is long and is what a person
 * turns to afterwards. So the grouping by agent stays and the order within it changes:
 * 「動きを見る」 then 「やったこと」.
 *
 * The two halves are still one state. Each picture reports the event it has reached,
 * and the account of that same task marks that row — so a person who pauses on a step
 * and scrolls down finds the sentence the picture was on.
 */
export function RunReplay(props: { runId: string; tasks: readonly ReplayTask[] }): Element {
  const [current, setCurrent] = useState<Readonly<Record<string, string | null>>>({});
  /*
   * A step that has not moved leaves the state alone, and an untouched picture reports
   * `null` — which is what the map already says about a task nobody has played. Without
   * the `?? null` the very first report of each picture would count as a change, and
   * hydrating a run of three tasks would re-render all three accounts to no effect.
   */
  const reach = useCallback((key: string, eventId: string | null): void => {
    setCurrent((previous) => ((previous[key] ?? null) === eventId ? previous : { ...previous, [key]: eventId }));
  }, []);

  if (props.tasks.length === 0) return null;
  return (
    <>
      <section className="run-stages" data-run-stages={props.runId}>
        <h3>{RUN_STAGES_CAPTION}</h3>
        <p className="run-note">{RUN_STAGES_NOTE}</p>
        {props.tasks.map((task) => (
          <article
            key={task.taskKey}
            className="task-replay"
            data-replay-for={task.taskKey}
            data-task-id={task.taskId}
          >
            <h4>
              <span className="col-task-id">{task.taskId}</span>
              <span className="task-replay-purpose">{task.purpose}</span>
            </h4>
            <p className="task-replay-meta">
              <LocalTime at={task.completedAt} />
              <span className="task-replay-count">{`${task.events.length} 件`}</span>
            </p>
            <TaskStage
              taskId={task.taskId}
              taskKey={task.taskKey}
              events={task.events}
              simulated={task.simulated}
              onCurrentEvent={(eventId) => reach(task.taskKey, eventId)}
            />
          </article>
        ))}
      </section>
      <section className="run-record" data-run-record={props.runId}>
        <h3>{RUN_RECORD_CAPTION}</h3>
        <p className="run-note">{RUN_RECORD_NOTE}</p>
        {props.tasks.map((task) => (
          <article key={task.taskKey} className="task-record" data-record-for={task.taskKey}>
            <h4>
              <span className="col-task-id">{task.taskId}</span>
              <span className="task-replay-purpose">{task.purpose}</span>
            </h4>
            <EventLog
              taskId={task.taskId}
              taskKey={task.taskKey}
              events={task.logEvents}
              currentEventId={current[task.taskKey] ?? null}
            />
          </article>
        ))}
      </section>
    </>
  );
}
