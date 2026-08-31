import type { RiskLevel } from '../correlate/finding.js';

export const LEVEL_BOUNDARIES = { medium: 30, high: 60, critical: 80 } as const;

export class ScoreOutOfRange extends Error {
  constructor(readonly score: number) { super(`score out of range: ${score}`); }
}

/**
 * Four bands, with the boundaries stated once.
 *
 * A score outside 0–100 is a bug in the scorer, not an input to clamp: silently
 * squeezing 140 into CRITICAL would hide the fact that the sum stopped being bounded.
 */
export function toLevel(score: number): RiskLevel {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new ScoreOutOfRange(score);
  if (score >= LEVEL_BOUNDARIES.critical) return 'CRITICAL';
  if (score >= LEVEL_BOUNDARIES.high) return 'HIGH';
  if (score >= LEVEL_BOUNDARIES.medium) return 'MEDIUM';
  return 'LOW';
}
