import { ResultMark, formatDuration, phaseLabel } from './visual.js';
import type { ActivityRecord } from '@xaa/contracts';
import { emphasisClass } from '../replay/emphasis.js';
import { labelOf, roleTextOf } from '../roles.js';
import { DetailDisclosure } from './detail-disclosure.js';
import { LocalTime } from './local-time.js';
import { OutcomeBadge } from './outcome-badge.js';
import { PhaseIcon } from './phase-icon.js';
import { RecordView } from './record-view.js';
import { RouteStrip } from './route-strip.js';
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
 * Down the left runs a rail with a mark per row — the phase's glyph, in the colour of
 * how the row ended — so a long account can be scanned for the one amber mark without
 * reading. Beside each time is how long after the previous row it happened: the
 * recorded instants, subtracted, and nothing else.
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
      <ol className="event-outline" aria-label="記録された処理の流れ">
        {props.events.map((event, index) => <li key={event.event_id} data-outcome={event.outcome} data-phase={event.phase}>
          <span>{String(index + 1).padStart(2, '0')}</span><ResultMark outcome={event.outcome} /><strong><PhaseIcon phase={event.phase} />{phaseLabel(event.phase)}</strong>
          <small>{labelOf(event.source)}</small><span className="sr-only">{event.outcome}</span>
        </li>)}
      </ol>
      <ol className="event-entries">
        {props.events.map((event, index) => {
          const previous = index > 0 ? props.events[index - 1] : undefined;
          const elapsed = previous ? Date.parse(event.occurred_at) - Date.parse(previous.occurred_at) : null;
          return (
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
              <span className="event-rail" data-outcome={event.outcome} aria-hidden="true"><PhaseIcon phase={event.phase} /></span>
              <p className="event-head">
                <span className="event-order">{String(index + 1)}</span>
                <span className="event-source">{labelOf(event.source)}</span>
                <span className="event-source-role" data-field="event-source-role">{roleTextOf(event.source)}</span>
                <LocalTime className="event-time" at={event.occurred_at} />
                {elapsed !== null && Number.isFinite(elapsed)
                  ? <span className="event-elapsed" data-field="event-elapsed" title="前の行からの経過">+{formatDuration(elapsed)}</span>
                  : null}
                <OutcomeBadge outcome={event.outcome} phase={event.phase} />
              </p>
              <p className="event-title">{event.title}</p>
              <p className="event-message">{event.message}</p>
              {event.record?.hops && event.record.hops.length > 0 ? <RouteStrip hops={event.record.hops} compact /> : null}
              <RecordView {...(event.record ? { record: event.record } : {})} />
              <DetailDisclosure {...(event.detail ? { detail: event.detail } : {})} />
            </li>
          );
        })}
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
