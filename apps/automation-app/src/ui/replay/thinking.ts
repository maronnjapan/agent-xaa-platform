import type { ActivityRecord, ActivityRecordCheck, ActivityRecordField, ActivityRecordSection } from '@xaa/contracts';
import { roleOf, type ActorRole } from '../roles.js';

/**
 * The reasoning behind one step, pulled out of the record its publisher wrote.
 *
 * A replay used to answer "what moved where". The question people actually asked was
 * the other one: 「AI エージェントがどういうことを考えて、どうするかを決めたのか」. That
 * answer was already on the page — it is in the record's sections — but folded into a
 * `<details>` below a diagram, in the same shape as the request bodies and the token
 * expiries, where nobody opened it while the picture was moving.
 *
 * So this file sorts one record's parts into the four beats of a decision, and the
 * panel beside the canvas plays them with the step they belong to:
 *
 *   read     — what the agent was handed at the head of this step
 *   thought  — its own words about what to do, as prose
 *   decided  — the choice, as named values: the tool, the arguments, the verdicts
 *   checks   — what it made sure of before anything left the process
 *
 * The sorting is by two things the publisher stated and nothing else: the section's
 * `id`, and whether it marked its text as prose. Not one sentence is written here, and
 * none is rephrased — every word the panel shows is a `label`, a `message`, a `text` or
 * a `value` from the record (RULE-54, REQ-11-002). A file that summarised a note into
 * "エージェントは X を選びました" would be inventing the one thing a person came to read.
 */

/** What the step was handed. The publisher names these sections; this lists them. */
const READ_SECTIONS: readonly string[] = ['received', 'work_definition'];

export interface ThinkingBlock {
  id: string;
  label: string;
  message: string;
  text: string;
  format: 'text' | 'json';
  fields: readonly ActivityRecordField[];
}

export interface ThinkingFrame {
  eventId: string;
  /** Who was thinking: the part that published the event, from the role dictionary. */
  actor: ActorRole | null;
  source: string;
  /** The publisher's own one-line summary of the step, when it wrote one. */
  headline: string;
  /** Which step of the run this was, when the publisher numbered it. */
  step: number | null;
  title: string;
  message: string;
  read: readonly ThinkingBlock[];
  thought: readonly ThinkingBlock[];
  decided: readonly ThinkingBlock[];
  checks: readonly ActivityRecordCheck[];
  /** True when the record carried more than the event's own two sentences. */
  hasRecord: boolean;
}

interface ThinkingSource {
  event_id: string;
  source: string;
  title?: string;
  message: string;
  record?: ActivityRecord;
}

/** Prose is what the publisher said it was: `format: 'text'` with something written. */
export function isProse(section: ActivityRecordSection): boolean {
  return section.format === 'text' && typeof section.text === 'string' && section.text.trim() !== '';
}

function toBlock(section: ActivityRecordSection): ThinkingBlock {
  return {
    id: section.id,
    label: section.label,
    message: section.message ?? '',
    text: section.text ?? '',
    format: section.format ?? 'text',
    fields: section.fields ?? [],
  };
}

/**
 * One event's reasoning, in the order a person reads it.
 *
 * An event with no record still produces a frame: its own `title` and `message` are
 * what its publisher had to say about it, and a panel that went blank on the steps
 * without a breakdown would look broken rather than brief.
 */
export function thinkingOf(event: ThinkingSource): ThinkingFrame {
  const record = event.record;
  const sections = record?.sections ?? [];
  const read: ThinkingBlock[] = [];
  const thought: ThinkingBlock[] = [];
  const decided: ThinkingBlock[] = [];

  for (const section of sections) {
    if (READ_SECTIONS.includes(section.id)) read.push(toBlock(section));
    // Prose is someone's own words — the model's note, the person's instruction — and
    // it is the answer to "what was it thinking". Named values are the answer to "what
    // did it then do". A section with both is one block: the values are the decision
    // the prose is explaining, and splitting them would separate a quotation from the
    // choice it is about.
    else if (isProse(section)) thought.push(toBlock(section));
    else decided.push(toBlock(section));
  }

  return {
    eventId: event.event_id,
    actor: roleOf(event.source),
    source: event.source,
    headline: record?.headline ?? '',
    step: typeof record?.step === 'number' ? record.step : null,
    title: event.title ?? '',
    message: event.message,
    read,
    thought,
    decided,
    checks: record?.checks ?? [],
    hasRecord: record !== undefined,
  };
}

/**
 * The frames of a whole task, keyed by the event each belongs to.
 *
 * The replay steps through hops, and one event can be four of them — a tool call is
 * four exchanges. The reasoning belongs to the event, not to the hop, so the panel
 * looks its frame up by `event_id` and holds it steady across the exchanges the step
 * is made of, rather than flickering four times through one decision.
 */
export function thinkingByEvent(events: readonly ThinkingSource[]): Map<string, ThinkingFrame> {
  return new Map(events.map((event) => [event.event_id, thinkingOf(event)]));
}

/** True when the frame has something beyond the event's own sentence to show. */
export function hasThinking(frame: ThinkingFrame): boolean {
  return frame.read.length > 0 || frame.thought.length > 0
    || frame.decided.length > 0 || frame.checks.length > 0;
}
