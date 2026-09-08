/** Safe monitoring projection: no raw logs, prompts, credentials or model output. */
export const ANALYSIS_STAGES = ['collect', 'normalize', 'validateProtocol', 'detectRules', 'correlate', 'score', 'analyze', 'respond'] as const;
export type AnalysisStage = typeof ANALYSIS_STAGES[number];
export const LEVEL_BOUNDARIES = { medium: 30, high: 60, critical: 80 } as const;
export const REVIEW_CONFIDENCE_FLOOR = 0.7;
export const REVIEW_REQUIRED_RESPONSES = ['QUARANTINED', 'REVOKED', 'DESTROYED'] as const;
export interface AnalysisDecision {
  finding_id: string;
  agent_id: string | null;
  codes: string[];
  score: number;
  level: string;
  state: 'queued' | 'responding' | 'skipped' | 'analyzing' | 'review' | 'responded' | 'failed';
  reason: string;
  response: string | null;
  confidence: number | null;
  transition: string | null;
}
export interface AnalysisRun {
  run_id: string;
  human_subject: string;
  started_at: string;
  updated_at: string;
  status: 'running' | 'completed' | 'failed';
  stage: AnalysisStage;
  completed_stages: AnalysisStage[];
  input_count: number;
  normalized_count: number;
  unmapped_count: number;
  violation_count: number;
  rule_hit_count: number;
  decisions: AnalysisDecision[];
  error_code: string | null;
}
