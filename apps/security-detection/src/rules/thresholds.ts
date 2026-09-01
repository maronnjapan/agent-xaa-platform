import thresholds from '../../../../security-rules/thresholds.json' with { type: 'json' };

export interface RuleThreshold {
  medium_multiplier: number;
  high_multiplier: number;
  metrics?: string[];
  codes?: string[];
  /**
   * Absolute counts rather than multiples of a baseline. An agent's expected ID-JAG rate
   * says how much legitimate work it does; it says nothing about how many refusals are
   * normal, and the answer to that is the same for every agent: very few.
   */
  status_error?: { medium: number; high: number };
}

export const THRESHOLDS = thresholds as Record<string, RuleThreshold>;
