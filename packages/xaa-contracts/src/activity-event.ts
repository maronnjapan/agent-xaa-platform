import type { FromSchema } from 'json-schema-to-ts';
import { activityRecordSchema } from './activity-record.js';
import { compile } from './schema/validator.js';

/**
 * docs 11 §3.1. The Activity Event is the *display* record: what a person is shown
 * about their agent. It is deliberately separate from the security audit stream
 * (RULE-55) and from the structured logs — three channels, three audiences.
 *
 * `outcome` stays at three values on purpose. A timeline needs to say only whether
 * something happened, worked, or was stopped; the precise event name lives in
 * `detail.event_type`, where the replay reads it. Adding `error` or `denied` here
 * would push classification logic into every renderer.
 */
export const ACTIVITY_EVENT_PHASES = [
  'login', 'work_definition', 'authorization', 'provisioning', 'tool_call', 'security', 'lifecycle',
] as const;

export const ACTIVITY_EVENT_OUTCOMES = ['info', 'success', 'blocked'] as const;

export const activityEventSchema = {
  $id: 'activity-event',
  type: 'object',
  additionalProperties: false,
  required: [
    'event_id', 'trace_id', 'human_subject', 'agent_id', 'task_id', 'occurred_at',
    'source', 'phase', 'outcome', 'title', 'message', 'related_finding_id', 'is_simulated',
  ],
  properties: {
    event_id: { type: 'string', minLength: 1 },
    trace_id: { type: 'string', minLength: 1 },
    human_subject: { type: 'string', minLength: 1 },
    agent_id: { type: ['string', 'null'] },
    task_id: { type: 'string', minLength: 1 },
    occurred_at: { type: 'string', format: 'date-time' },
    source: { type: 'string', minLength: 1 },
    phase: { enum: ACTIVITY_EVENT_PHASES },
    outcome: { enum: ACTIVITY_EVENT_OUTCOMES },
    title: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    detail: { type: 'object' },
    /**
     * The breakdown of this one event, written by its publisher (docs 11 §3.4).
     *
     * Optional, and required of nobody: an event that is one fact — a login, a
     * confirmation — has nothing to break down, and an empty record on it would tell a
     * reader there is something to open when there is not.
     */
    record: activityRecordSchema,
    related_finding_id: { type: ['string', 'null'] },
    is_simulated: { type: 'boolean', default: false },
  },
} as const;

export type ActivityEvent = FromSchema<typeof activityEventSchema>;

const assertActivityEvent: (value: unknown) => asserts value is ActivityEvent = compile<ActivityEvent>(activityEventSchema);

/** The one validator both the publisher and the subscriber call. */
export function validateActivityEvent(input: unknown): ActivityEvent {
  assertActivityEvent(input);
  return input;
}
