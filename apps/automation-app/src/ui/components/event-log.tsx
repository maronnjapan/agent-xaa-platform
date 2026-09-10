import { useEffect } from 'react';
import type { ActivityEvent, ActivityRecord } from '@xaa/contracts';
import { emphasisClass } from '../replay/emphasis.js';
import { phaseLabelOf } from '../labels.js';
import { labelOf, nameOf } from '../roles.js';
import { LocalTime } from './local-time.js';
import { OutcomeBadge } from './outcome-badge.js';
import { PhaseIcon } from './phase-icon.js';
import { formatDuration as formatElapsed } from './visual.js';
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

/**
 * An event as the log renders it: the same values, named rather than spread.
 *
 * The event arrives from the store and is on its way to a browser. Spreading it would
 * forward whatever the store or a future publisher happens to add — the same reason
 * the agent status endpoint copies field by field (RULE-38).
 */
export function toLogEvent(event: ActivityEvent): LogEvent {
  return {
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    source: event.source,
    phase: event.phase,
    outcome: event.outcome,
    title: event.title,
    message: event.message,
    ...(event.detail ? { detail: event.detail as Record<string, unknown> } : {}),
    ...(event.record ? { record: event.record } : {}),
    simulated: event.is_simulated === true,
  };
}

export const EVENT_LOG_NO_ISSUES = 'この区切りに、遮断や失敗はありません。';

/**
 * The whole of a finished task, in words, as a list down the page — one line per event.
 *
 * It is rendered by the server and always present, which is the point: someone who
 * never presses play, or who cannot watch an animation at all, loses nothing but the
 * motion. Each row is one event's own title, headed by who did it in the words the
 * screen uses for that part (the formal name a hover away), which stage of the story it
 * belongs to, when, how long after the row before, and how it ended. What the part is
 * for is said once, in the record beside the rows, rather than on every row. Down the left runs
 * a rail with a mark per row — the phase's glyph, on a disc in the colour of how the row
 * ended — so a long account can be scanned for the one amber mark without reading. The
 * name and the phrase both come from the one role dictionary the diagram draws its
 * boxes from, so the picture and the text cannot call the same part two things.
 *
 * A row is a line and no more. What the event said, the checks it made, the route it
 * took and the bodies it sent are the account of that one event, shown beside the list
 * for the row that is chosen (`EventDetail`) — one event's whole account rather than
 * every event's, because ten opened records under ten rows was the wall nobody could
 * read. Each row is a link to its own account, so a person without script chooses a
 * row by following it; with script the same press chooses it in place.
 *
 * Which row is chosen is a prop rather than an attribute the browser pokes in
 * afterwards: one state, held by the viewer, rendered by both halves. The row that is
 * chosen is brought into view, gently, so a person who arrived from the picture is
 * never looking at the wrong line.
 */
export function EventLog(props: {
  taskId: string;
  taskKey?: string;
  events: readonly LogEvent[];
  /** The event whose account is showing, if any. */
  currentEventId?: string | null;
  /** Where a row leads: the account of that event, as an address a browser without script can follow. */
  hrefFor?: (event: LogEvent) => string;
  onSelect?: (eventId: string) => void;
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
        {props.events.map((event, index) => {
          const previous = index > 0 ? props.events[index - 1] : undefined;
          const elapsed = previous ? Date.parse(event.occurred_at) - Date.parse(previous.occurred_at) : null;
          const state = entryState(index, currentIndex);
          const body = (
            <>
              <span className="event-order">{String(index + 1)}</span>
              <span className="event-line">
                <span className="event-title">{event.title}</span>
                <span className="event-head">
                  <span className="event-actor" data-field="event-actor" title={labelOf(event.source)}>{nameOf(event.source)}</span>
                  <span className="event-phase" data-field="event-phase">{phaseLabelOf(event.phase)}</span>
                  <LocalTime className="event-time" at={event.occurred_at} format="time" />
                  {elapsed !== null && Number.isFinite(elapsed)
                    ? <span className="event-elapsed" data-field="event-elapsed" title="前の行からの経過">{`+${formatElapsed(elapsed)}`}</span>
                    : null}
                  <OutcomeBadge outcome={event.outcome} phase={event.phase} />
                </span>
              </span>
            </>
          );
          return (
            <li
              key={event.event_id}
              className="event-entry"
              data-event-id={event.event_id}
              data-entry-index={String(index)}
              data-source={event.source}
              data-phase={event.phase}
              data-emphasis={emphasisClass(event.outcome, event.phase)}
              data-entry-state={state}
            >
              <span className="event-rail" data-outcome={event.outcome} aria-hidden="true">
                <PhaseIcon phase={event.phase} />
              </span>
              {props.hrefFor
                ? (
                  <a
                    className="event-row"
                    href={props.hrefFor(event)}
                    data-action="select-event"
                    {...(state === 'current' ? { 'aria-current': 'true' as const } : {})}
                    onClick={props.onSelect
                      ? (press) => { press.preventDefault(); props.onSelect?.(event.event_id); }
                      : undefined}
                  >
                    {body}
                  </a>
                )
                : <div className="event-row">{body}</div>}
            </li>
          );
        })}
      </ol>
      <p className="event-log-none" data-field="event-log-none">{EVENT_LOG_NO_ISSUES}</p>
    </section>
  );
}

/**
 * Brings the chosen row into view.
 *
 * A component of its own, and the only thing in this file with a hook, so the list
 * itself stays a plain function of its props — which is how the tests call it and how
 * the server renders it. It renders nothing; the effect finds the row by the key the
 * list was served with, and asks the browser to scroll only as far as needed, so a
 * person is never yanked away from the line they were on.
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
 * Three states rather than two: the row whose account is showing, the rows before it,
 * and the rows after — so a person reading down the list sees where they are. Before
 * any row is chosen, every row is waiting, which is true.
 */
function entryState(index: number, currentIndex: number): 'waiting' | 'current' | 'played' {
  if (currentIndex < 0) return 'waiting';
  if (index === currentIndex) return 'current';
  return index < currentIndex ? 'played' : 'waiting';
}
