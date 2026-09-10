import scoring from '../../../../security-rules/scoring.json' with { type: 'json' };
import { compile, type ScoreBreakdown } from '@xaa/contracts';
import { CRITICAL_SINGLETON_FACTORS, SCORE_FACTORS, factorFor, type ScoreFactor } from './factors.js';
import type { SecurityFinding } from '../correlate/finding.js';

export interface FactorWeight { per_event: number; cap: number }

const scoringSchema = {
  $id: 'security-scoring',
  type: 'object',
  additionalProperties: false,
  required: [...SCORE_FACTORS],
  properties: Object.fromEntries(SCORE_FACTORS.map((factor) => [factor, {
    type: 'object', additionalProperties: false, required: ['per_event', 'cap'],
    properties: { per_event: { type: 'integer', minimum: 0 }, cap: { type: 'integer', minimum: 0 } },
  }])),
} as const;

const assertScoring: (value: unknown) => asserts value is Record<ScoreFactor, FactorWeight> =
  compile<Record<ScoreFactor, FactorWeight>>(scoringSchema);

// Validated at load: a config with a missing or extra factor is a scoring model nobody
// reviewed, and finding that out at startup is better than at the first incident.
assertScoring(scoring);
export const SCORING = scoring as Record<ScoreFactor, FactorWeight>;

export interface ScoreCounters { unmapped_code_total: number }

/**
 * A number between 0 and 100, from the codes alone.
 *
 * Nothing random and nothing time-dependent goes in, so the same finding always scores
 * the same — which is what makes a finding id stable enough to overwrite. Each factor is
 * capped on its own before the sum, so one noisy rule cannot drown out everything else.
 *
 * The two singleton factors short-circuit the whole calculation. Their weights are in
 * the config for documentation, but the answer does not depend on them: an operator who
 * lowers `delegation_mismatch` to 1 has not made a forged delegation less serious.
 */
interface ScoreInput {
  finding: SecurityFinding;
  financeResourceUrl?: string;
  resources?: readonly string[];
  counters?: ScoreCounters;
}

export function computeScore(input: ScoreInput): number {
  return explainScore(input).score;
}

/** The same calculation supplies the score and its recorded explanation. */
export function explainScore(input: ScoreInput): ScoreBreakdown & { score: number } {
  let unmappedCount = 0;
  const counts = new Map<ScoreFactor, number>();
  for (const code of input.finding.contributing_codes) {
    const factor = factorFor(code);
    if (!factor) {
      unmappedCount += 1;
      if (input.counters) input.counters.unmapped_code_total += 1;
      continue;
    }
    counts.set(factor, (counts.get(factor) ?? 0) + 1);
  }

  const criticalOverride = CRITICAL_SINGLETON_FACTORS.some((factor) => counts.has(factor));

  // Only the finance resource carries a sensitivity premium: it is the one whose misuse
  // moves money.
  if (!criticalOverride && input.financeResourceUrl && input.resources?.includes(input.financeResourceUrl)) {
    counts.set('resource_sensitivity', (counts.get('resource_sensitivity') ?? 0) + 1);
  }

  const contributions = [...counts].map(([factor, count]) => {
    const weight = SCORING[factor];
    return { factor, count, per_event: weight.per_event, cap: weight.cap,
      points: Math.min(count * weight.per_event, weight.cap) };
  });
  return { score: criticalOverride ? 100 : Math.min(100, contributions.reduce((sum, item) => sum + item.points, 0)),
    contributions, critical_override: criticalOverride, unmapped_count: unmappedCount };
}
