import { ANALYSIS_STAGES, type AnalysisRun } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

export async function readAnalysisRuns(documents: DocumentStore, humanSubject: string): Promise<AnalysisRun[]> {
  const rows = await documents.queryEqual<AnalysisRun>('security_analysis', [['human_subject', humanSubject]], 30, { field: 'started_at', direction: 'desc' });
  return rows.map(({ data }) => data).filter((run) => run.human_subject === humanSubject)
    .sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 30)
    .map((run) => ({
      run_id: run.run_id, human_subject: run.human_subject, started_at: run.started_at, updated_at: run.updated_at,
      status: run.status, stage: run.stage, completed_stages: run.completed_stages,
      ...(run.stage_started_at ? { stage_started_at: run.stage_started_at } : {}),
      ...(run.stage_durations_ms ? { stage_durations_ms: Object.fromEntries(ANALYSIS_STAGES
        .filter((stage) => typeof run.stage_durations_ms?.[stage] === 'number')
        .map((stage) => [stage, run.stage_durations_ms![stage]])) } : {}),
      input_count: run.input_count, normalized_count: run.normalized_count, unmapped_count: run.unmapped_count,
      violation_count: run.violation_count, rule_hit_count: run.rule_hit_count, error_code: run.error_code,
      decisions: run.decisions.map((item) => ({
        finding_id: item.finding_id, agent_id: item.agent_id, codes: item.codes, score: item.score, level: item.level,
        ...(item.score_breakdown ? { score_breakdown: {
          critical_override: item.score_breakdown.critical_override,
          unmapped_count: item.score_breakdown.unmapped_count,
          contributions: item.score_breakdown.contributions.map((part) => ({
            factor: part.factor, count: part.count, per_event: part.per_event, cap: part.cap, points: part.points,
          })),
        } } : {}),
        state: item.state, reason: item.reason, response: item.response, confidence: item.confidence, transition: item.transition,
      })),
    }));
}
