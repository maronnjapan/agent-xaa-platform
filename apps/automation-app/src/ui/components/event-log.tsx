import type { ActivityRecord } from '@xaa/contracts';
import { emphasisClass } from '../replay/emphasis.js';
import { REPLAY_NODES } from '../replay/nodes.js';
import { DetailDisclosure } from './detail-disclosure.js';
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

export const EVENT_LOG_CAPTION = '起きたことを順番に';
export const EVENT_LOG_NOTE = '上から順に、この処理で実際に起きたことです。図の再生に合わせて、いま説明している行が強調されます。';

/**
 * Which box on the diagram published a line, named the way the box is named.
 *
 * The picture and the text have to agree about what to call things, or a person
 * reading 「Agent Runtime が…」 beside a box captioned something else has two systems
 * to reconcile instead of one. A source with no box of its own — Lifecycle Manager,
 * Security Detection — is shown as it was published rather than given a name here;
 * naming it would be this file inventing vocabulary, which is what RULE-54 forbids.
 */
function sourceLabel(source: string): string {
  return REPLAY_NODES.find((node) => node.id === source)?.label ?? source;
}

/**
 * The whole of a finished task, in words, above and beside its replay.
 *
 * It is rendered by the server and always present, which is the point: the animation
 * shows the shape of what happened, and this shows what happened. Someone who never
 * presses play, or who cannot watch an animation at all, loses nothing but the motion.
 *
 * Each row carries its `event_id` so the browser can mark the one the replay has
 * reached. The browser sets an attribute and nothing else — the words are all here,
 * server-rendered, exactly as their publishers wrote them.
 */
export function EventLog(props: { taskId: string; events: readonly LogEvent[] }): Element {
  return (
    <section class="event-log" data-event-log={props.taskId}>
      <h3>{EVENT_LOG_CAPTION}</h3>
      <p class="event-log-note">{EVENT_LOG_NOTE}</p>
      <ol>
        {props.events.map((event, index) => (
          <li
            class="event-entry"
            data-event-id={event.event_id}
            data-entry-index={String(index)}
            data-emphasis={emphasisClass(event.outcome, event.phase)}
            data-entry-state="waiting"
          >
            <p class="event-head">
              <span class="event-order">{String(index + 1)}</span>
              <span class="event-source">{sourceLabel(event.source)}</span>
              <time class="event-time" datetime={event.occurred_at}>{event.occurred_at}</time>
              <OutcomeBadge outcome={event.outcome} phase={event.phase} />
            </p>
            <p class="event-title">{event.title}</p>
            <p class="event-message">{event.message}</p>
            <RecordView {...(event.record ? { record: event.record } : {})} />
            <DetailDisclosure {...(event.detail ? { detail: event.detail } : {})} />
          </li>
        ))}
      </ol>
    </section>
  );
}
