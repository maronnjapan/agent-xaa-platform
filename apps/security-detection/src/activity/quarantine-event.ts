import { publishActivityEvent, type ActivityEvent } from '@xaa/contracts';
import type { RiskLevel } from '../correlate/finding.js';

export const QUARANTINE_EVENT_TYPE = 'AGENT_QUARANTINED';

/**
 * Everything a person is shown about a quarantine, and nothing else.
 *
 * Five fields, fixed by the type. `related_events` and the finding's `detail` are absent
 * on purpose: a timeline says what happened to somebody's agent, and the correlation ids
 * and rule internals behind that decision belong to the security stream, which has a
 * different retention and a different reader (RULE-55).
 */
export interface QuarantinePayload {
  agent_id: string;
  human_subject: string;
  /** Required. A quarantine with no finding behind it is not a thing this can describe. */
  related_finding_id: string;
  risk_level: RiskLevel;
  contributing_codes: string[];
}

const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{10,}/;

export class QuarantineEventRejected extends Error {
  readonly code = 'quarantine_event_rejected';
}

/**
 * Published once, after the Lifecycle Manager has agreed to move the agent.
 *
 * The order matters: an event published before the request would tell the person their
 * agent was isolated when it may still be working. The caller emits this only on a `sent`
 * transition to QUARANTINED, so a refused or failed request produces no event at all.
 *
 * The wording is one string with the finding id in it, not a template anyone can swap.
 * The message is written here, at the moment the event is made (RULE-55), so replaying a
 * timeline a year from now shows what the person was actually told rather than what
 * today's copy would say.
 *
 * The topic is the Activity stream and never `security-events`: the two are separate
 * channels for separate audiences, and a detection finding on a person's screen is as
 * wrong as their timeline in the detection pipeline.
 */
export async function emitQuarantineEvent(input: {
  payload: QuarantinePayload;
  traceId: string;
  occurredAt?: string;
  publish?: (event: ActivityEvent) => Promise<void>;
}): Promise<ActivityEvent> {
  const payload = input.payload;
  if (payload.related_finding_id === '') throw new QuarantineEventRejected('related_finding_id is required');
  if (payload.human_subject === '') throw new QuarantineEventRejected('human_subject is required');
  // A token in a display record would outlive the incident on somebody's screen. The
  // producers redact their own logs; this is the last place to notice one got through.
  if (JWT_SHAPE.test(JSON.stringify(payload))) throw new QuarantineEventRejected('payload must not contain a compact JWS');

  const event: ActivityEvent = {
    // Derived, so a redelivered batch that quarantines the same agent again writes the
    // same row rather than a second one (RULE-59).
    event_id: `evt-${payload.agent_id}-${QUARANTINE_EVENT_TYPE}`,
    trace_id: input.traceId,
    human_subject: payload.human_subject,
    agent_id: payload.agent_id,
    task_id: 'lifecycle',
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    source: 'security-detection',
    phase: 'security',
    outcome: 'blocked',
    title: 'Agent を隔離しました',
    message: `異常検知により Agent を隔離しました（Finding: ${payload.related_finding_id}）`,
    // `event_type` is the key the timeline reads to know a lifecycle task has ended
    // (RULE-59); the rest of `detail` is exactly the five permitted fields.
    detail: { event_type: QUARANTINE_EVENT_TYPE, ...payload },
    related_finding_id: payload.related_finding_id,
    is_simulated: false,
  };
  await (input.publish ?? publishActivityEvent)(event);
  return event;
}
