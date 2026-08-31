import { createHash } from 'node:crypto';

export const FINDING_TYPES = [
  'anomalous_agent_activity', 'potential_agent_compromise',
  'cross_agent_lateral_movement', 'platform_wide_isolation_breach',
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ReviewStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface SecurityFinding {
  finding_id: string;
  finding_type: FindingType;
  agent_id: string | null;
  human_subject: string;
  window_start: string;
  window_end: string;
  related_events: string[];
  contributing_codes: string[];
  risk_score: number | null;
  risk_level: RiskLevel | null;
  review_status: ReviewStatus;
  created_at: string;
}

/**
 * The same window and the same agent always give the same id.
 *
 * A random id would create a new row on every retry, so a transient failure would look
 * like a burst of incidents. Deriving it from the window and the subject means a rerun
 * overwrites its own earlier attempt and nothing else.
 */
export function findingId(windowStart: number, subject: string): string {
  const digest = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 8);
  return `f_${Math.floor(windowStart / 1000)}_${digest}`;
}

/**
 * Codes that together suggest something is wrong with the agent itself rather than with
 * one request it made.
 *
 * Three or more distinct families is the line: one unknown audience is a mistake, and
 * an unknown audience plus an isolation breach plus a burst of ID-JAGs is a pattern.
 */
const COMPROMISE_FAMILIES = [
  (code: string) => code.startsWith('authorization.unknown_audience'),
  (code: string) => code.startsWith('isolation.'),
  (code: string) => code.startsWith('token.id_jag_issued.'),
  (code: string) => code.startsWith('authorization.status_error.'),
];

export function classify(codes: readonly string[]): FindingType {
  const families = COMPROMISE_FAMILIES.filter((matches) => codes.some(matches)).length;
  return families >= 3 ? 'potential_agent_compromise' : 'anomalous_agent_activity';
}
