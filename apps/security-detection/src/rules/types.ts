export const RULE_CATEGORIES = [
  'token', 'authorization', 'tool', 'lifetime', 'isolation', 'authorization_ai',
] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number];
export type RuleLevel = 'MEDIUM' | 'HIGH';

export interface RuleHit {
  rule_id: string;
  category: RuleCategory;
  level: RuleLevel;
  agent_id: string;
  human_subject: string;
  occurred_at: string;
  trace_id: string;
  related_events: string[];
  detail: Record<string, unknown>;
}

/** Stable identity for the dedup a cross-agent correlation needs. */
export function hitId(hit: RuleHit): string {
  return `${hit.rule_id}|${hit.agent_id}|${hit.occurred_at}|${hit.trace_id}`;
}
