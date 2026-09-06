import type { ActivityRecord } from '@xaa/contracts';
import { emphasisClass } from '../replay/emphasis.js';
import { labelOf, roleTextOf } from '../roles.js';
import { DetailDisclosure } from './detail-disclosure.js';
import { LocalTime } from './local-time.js';
import { OutcomeBadge } from './outcome-badge.js';
import { RecordView } from './record-view.js';
import type { Element } from '../element.js';

export interface LogEvent {
  event_id: string;
  occurred_at: string;
  source: string;
  phase: string;
  outcome: string;
  title: string;
  message: string;
  detail?: Record<string, unknown>;
  record?: ActivityRecord;
}

/**
 * The whole of a finished task, in words, under 「やったこと」.
 *
 * It is rendered by the server and always present, which is the point: the animation
 * shows the shape of what happened, and this shows what happened. Someone who never
 * presses play, or who cannot watch an animation at all, loses nothing but the motion.
 *
 * Each row names the part that published it and, beside the name, what that part is
 * for. A log whose every line began `agent-op` and assumed the reader knew what an
 * Agent OP was is a log only its authors could read — which is what people said about
 * it. The name and the phrase both come from the one role dictionary the diagram draws
 * its boxes from, so the picture and the text cannot call the same part two things.
 *
 * Which row the replay has reached is a prop rather than an attribute the browser
 * pokes in afterwards: one state, held by the task's picture, rendered by both halves.
 * The section says whether any picture is on it at all, because a log nothing is
 * playing against has no passed rows to dim — every row of it reads at full strength.
 */
export function EventLog(props: {
  taskId: string;
  taskKey?: string;
  events: readonly LogEvent[];
  /** The event the picture is currently on, if it is playing. */
  currentEventId?: string | null;
}): Element {
  const current = props.currentEventId ?? null;
  const currentIndex = current === null ? -1 : props.events.findIndex((event) => event.event_id === current);
  return (
    <section
      className="event-log"
      data-event-log={props.taskId}
      data-log-key={props.taskKey ?? props.taskId}
      data-log-state={current === null ? 'idle' : 'playing'}
    >
      <ol>
        {props.events.map((event, index) => (
          <li
            key={event.event_id}
            className="event-entry"
            data-event-id={event.event_id}
            data-entry-index={String(index)}
            data-source={event.source}
            data-emphasis={emphasisClass(event.outcome, event.phase)}
            data-entry-state={entryState(index, currentIndex)}
          >
            <p className="event-head">
              <span className="event-order">{String(index + 1)}</span>
              <span className="event-source">{labelOf(event.source)}</span>
              <span className="event-source-role" data-field="event-source-role">{roleTextOf(event.source)}</span>
              <LocalTime className="event-time" at={event.occurred_at} />
              <OutcomeBadge outcome={event.outcome} phase={event.phase} />
            </p>
            <p className="event-title">{event.title}</p>
            <p className="event-message">{event.message}</p>
            <RecordView {...(event.record ? { record: event.record } : {})} />
            <DetailDisclosure {...(event.detail ? { detail: event.detail } : {})} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Three states rather than two: an entry the replay has passed reads differently from
 * one it has not reached yet, and a person who paused halfway needs to see where the
 * boundary is. Before anything plays, every entry is waiting — which is true.
 */
function entryState(index: number, currentIndex: number): 'waiting' | 'current' | 'played' {
  if (currentIndex < 0) return 'waiting';
  if (index === currentIndex) return 'current';
  return index < currentIndex ? 'played' : 'waiting';
}
