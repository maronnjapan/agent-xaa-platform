import type { NormalizedEvent } from '../normalize/index.js';
import type { SecurityFinding } from '../correlate/finding.js';
import { toLevel } from '../score/level.js';
import { explainScore } from '../score/compute.js';
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
  /**
   * The LOW half of docs 09 §5.5 — 「LOWは保存と観測にとどめ」. Kept apart from
   * `storeFinding` because the two write different rows: this one is the mechanical
   * passes and nothing else, and it must never be handed to the model.
   */
  storeLowFinding(finding: SecurityFinding): Promise<void>;
  storeFinding(finding: SecurityFinding): Promise<void>;
  financeResourceUrl?: string;
  resourcesFor?(finding: SecurityFinding): readonly string[];
}

export function score(batch: CorrelatedBatch, deps: Pick<DispatchDeps, 'financeResourceUrl' | 'resourcesFor'>, counters: DispatchCounters): ScoredBatch {
  return {
    __stage: 'scored',
    events: batch.events,
    findings: batch.findings.map((finding) => {
      const { score: value, ...breakdown } = explainScore({
        finding,
        ...(deps.financeResourceUrl ? { financeResourceUrl: deps.financeResourceUrl } : {}),
        ...(deps.resourcesFor ? { resources: deps.resourcesFor(finding) } : {}),
        counters: { get unmapped_code_total() { return counters.unmapped_code_total; },
                    set unmapped_code_total(next: number) { counters.unmapped_code_total = next; } },
      });
      return { ...finding, risk_score: value, risk_level: toLevel(value), score_breakdown: breakdown };
    }),
  };
}

/**
 * What happens after a score exists.
 *
 * LOW stops short of the model: a counter moves and the row is written as the mechanical
 * result it is, with nothing asked of the model and nothing asked of the Lifecycle
 * Manager. It is written rather than dropped because a person reading the console has no
 * other way to tell a window that was read and came back clean from a window whose logs
 * never arrived, and because 「LOWは保存と観測にとどめ」 (docs 09 §5.5) says stored, not
 * counted. `storeLowFinding` and `storeFinding` stay separate so that reading this
 * function still tells you which rows the model ever sees.
 */
export async function dispatch(batch: ScoredBatch, deps: DispatchDeps, counters: DispatchCounters): Promise<void> {
  for (const finding of batch.findings) {
    if (finding.risk_level === 'LOW') {
      counters.low_events_total += 1;
      await deps.storeLowFinding(finding);
      continue;
    }
    await deps.storeFinding(finding);
    await deps.analyze(finding, batch.events);
  }
}
