import type { Deviation } from '../baseline/deviation.js';
import type { NormalizedEvent } from '../normalize/index.js';
import type { RuleHit } from '../rules/types.js';
import type { SecurityFinding } from '../correlate/finding.js';

/**
 * Six stages, each with its own type.
 *
 * The `__stage` field is never read. It exists so the six batch types are not
 * structurally interchangeable, which means `correlate(normalize(x))` — skipping
 * protocol validation — is a compile error rather than a subtle gap in coverage. The
 * order of detection is a security property, and this is how it is stated in a way the
 * compiler can hold.
 */
export interface RawLogBatch { readonly __stage: 'raw'; entries: readonly unknown[] }
export interface NormalizedBatch { readonly __stage: 'normalized'; events: NormalizedEvent[]; unmapped: NormalizedEvent[] }
export interface ValidatedBatch { readonly __stage: 'validated'; events: NormalizedEvent[]; violations: ProtocolViolationRecord[] }
export interface RuleHitBatch {
  readonly __stage: 'rule_hits';
  events: NormalizedEvent[];
  violations: ProtocolViolationRecord[];
  hits: RuleHit[];
  /** Per agent, and separate from `hits` on purpose: see `baseline/deviation.ts`. */
  deviations: Map<string, Deviation[]>;
}
/**
 * The events travel on past correlation because two later steps need the batch they came
 * from: the resource-sensitivity factor has to know which resources a finding's events
 * touched, and the Security AI summary is built from them. Re-reading the logs to answer
 * either would score a finding against evidence other than the evidence that produced it.
 */
export interface CorrelatedBatch { readonly __stage: 'correlated'; findings: SecurityFinding[]; events: NormalizedEvent[] }
export interface ScoredBatch { readonly __stage: 'scored'; findings: SecurityFinding[]; events: NormalizedEvent[] }

export interface ProtocolViolationRecord {
  code: string;
  agent_id: string | null;
  human_subject: string | null;
  occurred_at: string;
  trace_id: string;
  event: NormalizedEvent;
}
