import type { AnalysisRun } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

export async function readAnalysisRuns(documents: DocumentStore, humanSubject: string): Promise<AnalysisRun[]> {
  const rows = await documents.queryEqual<AnalysisRun>('security_analysis', [['human_subject', humanSubject]], 30, { field: 'started_at', direction: 'desc' });
  return rows.map(({ data }) => data).filter((run) => run.human_subject === humanSubject)
    .sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 30)
    .map((run) => ({
      run_id: run.run_id, human_subject: run.human_subject, started_at: run.started_at, updated_at: run.updated_at,
      status: run.status, stage: run.stage, completed_stages: run.completed_stages,
      input_count: run.input_count, normalized_count: run.normalized_count, unmapped_count: run.unmapped_count,
      violation_count: run.violation_count, rule_hit_count: run.rule_hit_count, error_code: run.error_code,
      decisions: run.decisions.map((item) => ({
        finding_id: item.finding_id, agent_id: item.agent_id, codes: item.codes, score: item.score, level: item.level,
        state: item.state, reason: item.reason, response: item.response, confidence: item.confidence, transition: item.transition,
      })),
    }));
}
