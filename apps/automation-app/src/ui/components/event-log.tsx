import { useEffect } from 'react';
import type { ActivityRecord } from '@xaa/contracts';
import { emphasisClass } from '../replay/emphasis.js';
import { phaseLabelOf } from '../labels.js';
import { labelOf, nameOf, roleTextOf } from '../roles.js';
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
  /** A scripted event, which must never be mistakable for one that happened (RULE-58). */
  simulated?: boolean;
}

export const EVENT_LOG_NO_BLOCKED = 'この区切りに、遮断されたできごとはありません。';

/**
 * The whole of a finished task, in words, as a list down the page.
 *
 * It is rendered by the server and always present, which is the point: the picture
 * beside it shows the shape of what happened, and this shows what happened. Someone
 * who never presses play, or who cannot watch an animation at all, loses nothing but
 * the motion.
 *
 * Each row is headed by who did it, in the words the screen uses for that part, with
 * the formal name a hover away; by which stage of the story it belongs to; by when;
 * and by how it ended. A log whose every line began `agent-op` and assumed the reader
 * knew what an Agent OP was is a log only its authors could read — which is what people
 * said about it. The name and the phrase both come from the one role dictionary the
 * diagram draws its boxes from, so the picture and the text cannot call the same part
 * two things. The title and the sentence under them are the publisher's own.
 *
 * Which row the replay has reached is a prop rather than an attribute the browser
 * pokes in afterwards: one state, held by the task's picture, rendered by both halves.
 * The section says whether any picture is on it at all, because a log nothing is
 * playing against has no passed rows to dim — every row of it reads at full strength.
 * When the picture moves on, the row it reached is brought into view, gently, so a
 * person reading beside the picture is never looking at the wrong line.
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
  const logKey = props.taskKey ?? props.taskId;
  return (
    <section
      className="event-log"
      data-event-log={props.taskId}
      data-log-key={logKey}
      data-log-state={current === null ? 'idle' : 'playing'}
    >
      <FollowCurrentRow logKey={logKey} current={current} />
      <ol className="event-list">
        {props.events.map((event, index) => (
          <li
            key={event.event_id}
            className="event-entry"
            data-event-id={event.event_id}
            data-entry-index={String(index)}
            data-source={event.source}
            data-phase={event.phase}
            data-emphasis={emphasisClass(event.outcome, event.phase)}
            data-entry-state={entryState(index, currentIndex)}
          >
            <div className="event-rail" aria-hidden="true">
              <span className="event-order">{String(index + 1)}</span>
            </div>
            <div className="event-body">
              <p className="event-head">
                <span className="event-actor" data-field="event-actor" title={labelOf(event.source)}>{nameOf(event.source)}</span>
                <span className="event-source-role" data-field="event-source-role">{roleTextOf(event.source)}</span>
                <span className="event-phase" data-field="event-phase">{phaseLabelOf(event.phase)}</span>
                <LocalTime className="event-time" at={event.occurred_at} format="short" />
                <OutcomeBadge outcome={event.outcome} phase={event.phase} />
              </p>
              <p className="event-title">{event.title}</p>
              <p className="event-message">{event.message}</p>
              <RecordView {...(event.record ? { record: event.record } : {})} />
              <DetailDisclosure {...(event.detail ? { detail: event.detail } : {})} simulated={event.simulated === true} />
            </div>
          </li>
        ))}
      </ol>
      <p className="event-log-none" data-field="event-log-none">{EVENT_LOG_NO_BLOCKED}</p>
    </section>
  );
}

/**
 * Brings the row the picture has reached into view.
 *
 * A component of its own, and the only thing in this file with a hook, so the list
 * itself stays a plain function of its props — which is how the tests call it and how
 * the server renders it. It renders nothing; the effect finds the row by the key the
 * list was served with, and asks the browser to scroll only as far as needed, so a
 * person reading beside the picture is never looking at the wrong line and never
 * yanked away from the one they were on.
 */
function FollowCurrentRow(props: { logKey: string; current: string | null }): Element {
  const { logKey, current } = props;
  useEffect(() => {
    if (current === null || typeof document === 'undefined') return;
    const rows = document.querySelectorAll<HTMLElement>('[data-log-key] [data-event-id]');
    const row = [...rows].find((entry) =>
      entry.getAttribute('data-event-id') === current && entry.closest('[data-log-key]')?.getAttribute('data-log-key') === logKey);
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [logKey, current]);
  return null;
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
