import type { NormalizedEvent } from '../normalize/index.js';
import type { RuleCategory, RuleHit, RuleLevel } from './types.js';

/**
 * One event, one hit.
 *
 * The count-driven classifications (token, and the HTTP refusals of `authorization`)
 * need a window and a ceiling before they can say anything. The rest do not: a tool that
 * is not in the catalogue, an ID-JAG redeemed after the agent expired, a request carrying
 * another agent's dedicated OP — each is wrong on its own, and waiting for a second one
 * before saying so would mean the first one is free.
 *
 * `rule_id` is passed in whole rather than assembled from a category and a level, so the
 * ids a query keys on are greppable literals.
 */
export function hitFromEvent(input: {
  ruleId: string;
  category: RuleCategory;
  level: RuleLevel;
  event: NormalizedEvent;
  detail: Record<string, unknown>;
  relatedEvents?: readonly string[];
}): RuleHit {
  return {
    rule_id: input.ruleId,
    category: input.category,
    level: input.level,
    agent_id: input.event.actor.agent_id ?? '',
    human_subject: input.event.actor.human_subject ?? '',
    occurred_at: input.event.time,
    trace_id: input.event.metadata.trace_id,
    related_events: [...(input.relatedEvents ?? [input.event.metadata.correlation_uid])],
    detail: input.detail,
  };
}

/** Events that carry an agent id, since every fixed rule id is reported per agent. */
export function withAgent(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return events.filter((event) => typeof event.actor.agent_id === 'string' && event.actor.agent_id !== '');
}

/**
 * A space-delimited log field, read as a list. OAuth carries `scope` as one string and
 * `audience` as either, so both spellings have to arrive at the same shape.
 */
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item !== '');
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

/**
 * A list field whose elements may themselves contain spaces, so it is never split.
 *
 * A capability the model invented can be `GET /v1/documents`, and splitting that on
 * whitespace would turn one malformed answer into two innocent-looking fragments —
 * exactly the thing the taxonomy check exists to catch.
 */
export function asElementList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item !== '');
  return typeof value === 'string' && value !== '' ? [value] : [];
}
