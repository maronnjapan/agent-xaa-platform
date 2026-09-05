import type { FromSchema } from 'json-schema-to-ts';
import { compile } from './schema/validator.js';

/**
 * docs 11 §3.4. The breakdown of one Activity Event, written by whoever produced it.
 *
 * `title` and `message` say what happened in one sentence. `detail` carries the
 * technical key/values as they are. Neither answers the question a person actually
 * asks about an agent — *where did it send what, what came back, what did it check
 * first, and what did it say about it* — because that answer is a sequence, not a
 * sentence and not a flat map.
 *
 * So this is a third thing, and its shape is the whole of the design: every word a
 * person reads is a `label`, a `message` or a `text` written at the moment it
 * happened, by the component that knows why. The screen orders them, indents them and
 * decides what starts folded. It never composes one (RULE-54, REQ-11-002) — a renderer
 * that phrased `status: 403` as "拒否されました" would be interpreting a record it did
 * not make, and would rewrite the past every time its wording changed.
 */

/**
 * The same three values as an Activity Event's own `outcome`, restated rather than
 * imported: `activity-event.ts` embeds this schema, and importing back the other way
 * would be a cycle. `activity-record.spec.ts` pins the two lists equal.
 */
export const ACTIVITY_RECORD_OUTCOMES = ['info', 'success', 'blocked'] as const;

/**
 * How a check ended. `skipped` is not a filler: a call refused at step 2 never reached
 * the constraint check, and saying so is different from saying the constraint passed.
 */
export const ACTIVITY_RECORD_CHECK_RESULTS = ['passed', 'blocked', 'failed', 'skipped'] as const;

/** How a section's `text` should be laid out. `json` gets a monospaced block. */
export const ACTIVITY_RECORD_TEXT_FORMATS = ['text', 'json'] as const;

const fieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'value'],
  properties: {
    label: { type: 'string', minLength: 1 },
    value: { type: 'string' },
  },
} as const;

const checkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'result', 'message'],
  properties: {
    id: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    result: { enum: ACTIVITY_RECORD_CHECK_RESULTS },
    message: { type: 'string', minLength: 1 },
  },
} as const;

const sectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label'],
  properties: {
    id: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    message: { type: 'string' },
    fields: { type: 'array', items: fieldSchema },
    text: { type: 'string' },
    format: { enum: ACTIVITY_RECORD_TEXT_FORMATS },
  },
} as const;

/**
 * One movement between two of the replay's boxes.
 *
 * Without these, one tool call is one arrow and the picture says only "the agent
 * touched a resource". A single call is in fact four exchanges — the Agent OP issues
 * an ID-JAG, the Resource AS turns it into an Access Token, the Resource API answers —
 * and those are exactly the hops a viewer needs to see to understand where a refusal
 * landed. `from` and `to` use the same `source` vocabulary as the event itself, so the
 * canvas resolves them with the map it already has.
 */
const hopSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to', 'label', 'outcome', 'message'],
  properties: {
    from: { type: 'string', minLength: 1 },
    to: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    outcome: { enum: ACTIVITY_RECORD_OUTCOMES },
    message: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * Deliberately without an `$id`.
 *
 * The schema is embedded in more than one parent — the Activity Event envelope and the
 * agent status response — and Ajv registers a nested `$id` the first time it sees it,
 * then refuses the second parent that carries the same one. An anonymous subschema is
 * compiled afresh in each parent, which costs one compilation at module load and makes
 * the third embedding a non-event.
 */
export const activityRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'sections'],
  properties: {
    headline: { type: 'string', minLength: 1 },
    step: { type: 'integer', minimum: 1 },
    duration_ms: { type: 'integer', minimum: 0 },
    checks: { type: 'array', items: checkSchema },
    sections: { type: 'array', items: sectionSchema },
    hops: { type: 'array', items: hopSchema },
  },
} as const;

export type ActivityRecord = FromSchema<typeof activityRecordSchema>;
export type ActivityRecordCheck = FromSchema<typeof checkSchema>;
export type ActivityRecordSection = FromSchema<typeof sectionSchema>;
export type ActivityRecordField = FromSchema<typeof fieldSchema>;
export type ActivityRecordHop = FromSchema<typeof hopSchema>;

const assertActivityRecord: (value: unknown) => asserts value is ActivityRecord =
  compile<ActivityRecord>(activityRecordSchema);

export function validateActivityRecord(input: unknown): ActivityRecord {
  assertActivityRecord(input);
  return input;
}

/**
 * A compact JWS, matched the way `@xaa/logging` matches one: the header segment of a
 * real token always begins `eyJ`, because it is base64url of a JSON object.
 *
 * Testing for dots alone is what a record like this cannot afford. Every tool id in
 * the platform is three dotted segments, so the loose pattern eats the one value the
 * whole screen is about.
 *
 * It is applied to the middle of a string rather than anchored, because a token that
 * reaches a record arrives inside a serialised body — `"access_token":"eyJ…"` — where
 * nothing separates it from the quotes around it.
 */
const EMBEDDED_JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Long enough for a response body worth reading, short enough not to be a dump. */
export const RECORD_TEXT_LIMIT = 2000;

export const RECORD_TRUNCATION_MARK = '…（以下省略）';

/**
 * The last gate before a record leaves the process that built it.
 *
 * A record is shown to a person and kept for as long as their timeline is, so anything
 * that reached it would outlive every place it was allowed to be (RULE-38). Publishers
 * are careful about which values they put in; this catches the one that arrived inside
 * a response body nobody inspected.
 */
export function redactRecordText(value: string): string {
  const redacted = value.replace(EMBEDDED_JWT, '[REDACTED]');
  return redacted.length > RECORD_TEXT_LIMIT
    ? `${redacted.slice(0, RECORD_TEXT_LIMIT)}${RECORD_TRUNCATION_MARK}`
    : redacted;
}
