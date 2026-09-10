import { emphasisClass } from '../replay/emphasis.js';
import { phaseLabelOf } from '../labels.js';
import { labelOf, nameOf, roleTextOf } from '../roles.js';
import { DetailDisclosure } from './detail-disclosure.js';
import type { LogEvent } from './event-log.js';
import { LocalTime } from './local-time.js';
import { OutcomeBadge } from './outcome-badge.js';
import { RecordView } from './record-view.js';
import { RouteStrip } from './route-strip.js';
import { SimulatedBadge } from './simulated-badge.js';
import type { Element } from '../element.js';

export const EVENT_DETAIL_CAPTION = 'このできごとの記録';

/**
 * One event's whole account, beside the list it was chosen from.
 *
 * Everything a row leaves out is here, for one event at a time: the publisher's own
 * sentence about it, the route it took as boxes and arrows standing still, the
 * breakdown its publisher wrote — the checks, the agent's own words, the folded bodies
 * — and the raw values behind a disclosure. One event's account fills the space a
 * person is looking at; the accounts of the other nine are one press away, not stacked
 * under it.
 *
 * Every word is the publisher's, or a fixed caption for a part of the screen; nothing
 * here says what the event meant (RULE-54).
 */
export function EventDetail(props: { event: LogEvent; order: number; total: number }): Element {
  const event = props.event;
  const hops = event.record?.hops ?? [];
  return (
    <article
      className="event-detail"
      data-event-detail={event.event_id}
      data-emphasis={emphasisClass(event.outcome, event.phase)}
      aria-live="polite"
    >
      <p className="event-detail-caption">
        {EVENT_DETAIL_CAPTION}
        <span className="event-detail-order" data-field="event-detail-order">{`${props.order} / ${props.total}`}</span>
      </p>
      <p className="event-detail-head">
        <span className="event-actor" data-field="event-actor" title={labelOf(event.source)}>{nameOf(event.source)}</span>
        <span className="event-source-role">{roleTextOf(event.source)}</span>
        <span className="event-phase">{phaseLabelOf(event.phase)}</span>
        <LocalTime className="event-time" at={event.occurred_at} format="short" />
        {event.simulated ? <SimulatedBadge position="row" /> : null}
        <OutcomeBadge outcome={event.outcome} phase={event.phase} />
      </p>
      <h3 className="event-detail-title" data-field="event-detail-title">{event.title}</h3>
      <p className="event-message" data-field="event-message">{event.message}</p>
      {hops.length > 0 ? <RouteStrip hops={hops} /> : null}
      <RecordView {...(event.record ? { record: event.record } : {})} />
      <DetailDisclosure {...(event.detail ? { detail: event.detail } : {})} simulated={event.simulated === true} />
    </article>
  );
}
