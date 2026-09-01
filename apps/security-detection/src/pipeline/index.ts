import { TOOL_BINDINGS } from '@xaa/contracts';
import { normalizeEntries, type NormalizedEvent } from '../normalize/index.js';
import { detectRuleHits, type AgentRegistrationView } from '../rules/index.js';
import { detectDeviations, type Deviation } from '../baseline/deviation.js';
import { correlate } from '../correlate/index.js';
import type { AgentBaseline } from '../baseline/types.js';
import type { SecurityFinding } from '../correlate/finding.js';
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

/** Which capability each tool needs, from the one table the Provisioner also built from. */
const TOOL_CAPABILITIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TOOL_BINDINGS).map(([toolId, binding]) => [toolId, binding.capability]),
);

/** The production wiring of the six stages. */
export function createPipelineDeps(input: {
  baselines: ReadonlyMap<string, AgentBaseline>;
  counters: DispatchCounters;
  registrations?: ReadonlyMap<string, AgentRegistrationView>;
  maxLifetimeSeconds?: number | null;
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
      hits: detectRuleHits({
        events: batch.events, violations: batch.violations, baselines: input.baselines,
        registrations: input.registrations ?? new Map(),
        maxLifetimeSeconds: input.maxLifetimeSeconds ?? null,
      }).hits,
      // Run beside the rules, never from inside them. The rules answer "did anything
      // cross a line"; this answers "what did the agent do that is not what it was built
      // for", and the second question still has an answer when the first does not.
      deviations: deviationsByAgent(batch.events, input.baselines),
    }),
    correlate: (batch) => ({
      __stage: 'correlated',
      findings: correlate({
        hits: batch.hits, violations: batch.violations, deviations: batch.deviations,
        ...(input.now ? { now: input.now } : {}),
      }),
      events: batch.events,
    }),
    score: (batch) => score(batch, {
      ...(input.financeResourceUrl ? { financeResourceUrl: input.financeResourceUrl } : {}),
      // Without this the resource-sensitivity factor is unreachable: `computeScore` only
      // adds it when it is told which resources the finding's events touched, and nothing
      // else in the pipeline knows.
      resourcesFor: (finding) => resourcesOf(finding, batch.events),
    }, input.counters),
  };
}

function deviationsByAgent(
  events: readonly NormalizedEvent[],
  baselines: ReadonlyMap<string, AgentBaseline>,
): Map<string, Deviation[]> {
  const byAgent = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const agentId = event.actor.agent_id;
    if (!agentId) continue;
    byAgent.set(agentId, [...(byAgent.get(agentId) ?? []), event]);
  }
  const deviations = new Map<string, Deviation[]>();
  for (const [agentId, agentEvents] of byAgent) {
    const baseline = baselines.get(agentId);
    if (!baseline) continue;
    deviations.set(agentId, detectDeviations({ baseline, events: agentEvents, toolCapabilities: TOOL_CAPABILITIES }));
  }
  return deviations;
}

/** The resources named by the events this finding was actually built from. */
export function resourcesOf(finding: SecurityFinding, events: readonly NormalizedEvent[]): string[] {
  const related = new Set(finding.related_events);
  return [...new Set(events
    .filter((event) => related.has(event.metadata.correlation_uid) && event.api.resource !== '')
    .map((event) => event.api.resource))];
}

export { dispatch, score };
export type { DispatchDeps, DispatchCounters };
