import type { NormalizedEvent } from '../normalize/index.js';
import type { SecurityFinding } from '../correlate/finding.js';
import { toLevel } from '../score/level.js';
import { computeScore } from '../score/compute.js';
import type { ScoredBatch, CorrelatedBatch } from './types.js';

export interface DispatchCounters {
  low_events_total: number;
  unmapped_code_total: number;
}

export interface DispatchDeps {
  /**
   * Called only for MEDIUM and above; the spy in tests counts these. The batch's events
   * come with it so the Security AI summary is built from the evidence this finding was
   * made of, rather than from a second read of the logs.
   */
  analyze(finding: SecurityFinding, events: readonly NormalizedEvent[]): Promise<void>;
  storeNormalized(finding: SecurityFinding): Promise<void>;
  storeFinding(finding: SecurityFinding): Promise<void>;
  financeResourceUrl?: string;
  resourcesFor?(finding: SecurityFinding): readonly string[];
}

export function score(batch: CorrelatedBatch, deps: Pick<DispatchDeps, 'financeResourceUrl' | 'resourcesFor'>, counters: DispatchCounters): ScoredBatch {
  return {
    __stage: 'scored',
    events: batch.events,
    findings: batch.findings.map((finding) => {
      const value = computeScore({
        finding,
        ...(deps.financeResourceUrl ? { financeResourceUrl: deps.financeResourceUrl } : {}),
        ...(deps.resourcesFor ? { resources: deps.resourcesFor(finding) } : {}),
        counters: { get unmapped_code_total() { return counters.unmapped_code_total; },
                    set unmapped_code_total(next: number) { counters.unmapped_code_total = next; } },
      });
      return { ...finding, risk_score: value, risk_level: toLevel(value) };
    }),
  };
}

/**
 * What happens after a score exists.
 *
 * LOW stops here: the event is kept and a counter moves, and no finding row is written
 * and no model is called. The branch is placed before the finding is built, not after —
 * constructing one and discarding it would still put a row-shaped object in front of
 * every later edit, and someone would eventually write it.
 */
export async function dispatch(batch: ScoredBatch, deps: DispatchDeps, counters: DispatchCounters): Promise<void> {
  for (const finding of batch.findings) {
    if (finding.risk_level === 'LOW') {
      counters.low_events_total += 1;
      await deps.storeNormalized(finding);
      continue;
    }
    await deps.storeFinding(finding);
    await deps.analyze(finding, batch.events);
  }
}
