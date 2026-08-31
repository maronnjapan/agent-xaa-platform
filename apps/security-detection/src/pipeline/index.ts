import { normalizeEntries } from '../normalize/index.js';
import { detectRuleHits } from '../rules/index.js';
import { correlate } from '../correlate/index.js';
import type { AgentBaseline } from '../baseline/types.js';
import { dispatch, score, type DispatchCounters, type DispatchDeps } from './dispatch.js';
import type {
  CorrelatedBatch, NormalizedBatch, ProtocolViolationRecord, RawLogBatch,
  RuleHitBatch, ScoredBatch, ValidatedBatch,
} from './types.js';

export interface PipelineDeps {
  collect(input: readonly unknown[]): RawLogBatch;
  normalize(batch: RawLogBatch): NormalizedBatch;
  validateProtocol(batch: NormalizedBatch): ValidatedBatch;
  detectRules(batch: ValidatedBatch): RuleHitBatch;
  correlate(batch: RuleHitBatch): CorrelatedBatch;
  score(batch: CorrelatedBatch): ScoredBatch;
}

/**
 * The six stages, called in the order they are declared.
 *
 * There is no branch that skips one. Protocol validation before rules, rules before
 * correlation, correlation before scoring: each stage reads what the last produced, and
 * a run that jumped from normalisation to correlation would be scoring evidence nobody
 * had checked. The types make that unwritable; this function makes it plain.
 */
export function runPipeline(entries: readonly unknown[], deps: PipelineDeps): ScoredBatch {
  return deps.score(deps.correlate(deps.detectRules(deps.validateProtocol(deps.normalize(deps.collect(entries))))));
}

export const PIPELINE_STAGES = ['collect', 'normalize', 'validateProtocol', 'detectRules', 'correlate', 'score'] as const;

/** The production wiring of the six stages. */
export function createPipelineDeps(input: {
  baselines: ReadonlyMap<string, AgentBaseline>;
  counters: DispatchCounters;
  financeResourceUrl?: string;
  now?: () => number;
}): PipelineDeps {
  return {
    collect: (entries) => ({ __stage: 'raw', entries }),
    normalize: (batch) => {
      const result = normalizeEntries(batch.entries);
      return { __stage: 'normalized', events: result.events, unmapped: result.unmapped };
    },
    /**
     * Protocol validation is a *reading*, not a re-decision (DEC-SEC-02): the service
     * that refused the request already made the call, synchronously, with the request in
     * front of it. This stage collects those verdicts out of the logs.
     */
    validateProtocol: (batch) => ({
      __stage: 'validated',
      events: batch.events,
      violations: batch.events.flatMap((event): ProtocolViolationRecord[] => {
        const validation = event.attributes.validation;
        if (typeof validation !== 'string') return [];
        return [{
          code: validation,
          agent_id: event.actor.agent_id,
          human_subject: event.actor.human_subject,
          occurred_at: event.time,
          trace_id: event.metadata.trace_id,
          event,
        }];
      }),
    }),
    detectRules: (batch) => ({
      __stage: 'rule_hits',
      events: batch.events,
      violations: batch.violations,
      hits: detectRuleHits({ events: batch.events, violations: batch.violations, baselines: input.baselines }).hits,
    }),
    correlate: (batch) => ({
      __stage: 'correlated',
      findings: correlate({ hits: batch.hits, violations: batch.violations, ...(input.now ? { now: input.now } : {}) }),
    }),
    score: (batch) => score(batch, {
      ...(input.financeResourceUrl ? { financeResourceUrl: input.financeResourceUrl } : {}),
    }, input.counters),
  };
}

export { dispatch, score };
export type { DispatchDeps, DispatchCounters };
