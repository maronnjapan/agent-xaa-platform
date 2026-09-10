import type { ActivityRecord, ActivityRecordCheck, ActivityRecordSection } from '@xaa/contracts';
import { roleOf, type ActorRole } from '../roles.js';

/**
 * The reasoning behind one step, pulled out of the record its publisher wrote.
 *
 * A replay used to answer "what moved where". The question people actually asked was
 * the other one: 「AI エージェントがどういうことを考えて、どうするかを決めたのか」. That
 * answer is in the record's sections, and the caption under the picture says it with
 * the step it belongs to — briefly. Under a moving picture there is room for two
 * things: the agent's own words, and what it made sure of before anything left the
 * process. The rest of the record — what it was handed, the values it chose, the
 * bodies it sent — is the written account's, one press away (docs 11 §5.2).
 *
 * The sorting is by two things the publisher stated and nothing else: the section's
 * `id`, which says whether it is what the agent was handed, and whether it marked the
 * section's text as prose. Not one sentence is written here, and none is rephrased —
 * every word the caption shows is a `label` or a `text` from the record (RULE-54,
 * REQ-11-002). A file that summarised a note into "エージェントは X を選びました" would be
 * inventing the one thing a person came to read.
 */

/** What the step was handed rather than what it thought. The publisher names these sections; this leaves them out. */
const READ_SECTIONS: readonly string[] = ['received', 'work_definition'];

export interface ThinkingBlock {
  id: string;
  label: string;
  message: string;
  text: string;
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
  /** Someone's own words about the step: the model's note, the person's instruction. */
  thought: readonly ThinkingBlock[];
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

/**
 * One event's reasoning, in the order a person reads it.
 *
 * An event with no record still produces a frame: its own `title` and `message` are
 * what its publisher had to say about it, and a panel that went blank on the steps
 * without a breakdown would look broken rather than brief.
 */
export function thinkingOf(event: ThinkingSource): ThinkingFrame {
  const record = event.record;
  const thought = (record?.sections ?? [])
    .filter((section) => isProse(section) && !READ_SECTIONS.includes(section.id))
    .map((section) => ({ id: section.id, label: section.label, message: section.message ?? '', text: section.text ?? '' }));
  return {
    eventId: event.event_id,
    actor: roleOf(event.source),
    source: event.source,
    headline: record?.headline ?? '',
    step: typeof record?.step === 'number' ? record.step : null,
    title: event.title ?? '',
    message: event.message,
    thought,
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
  return frame.thought.length > 0 || frame.checks.length > 0;
}
