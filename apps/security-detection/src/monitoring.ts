import { randomUUID } from 'node:crypto';
import type { AnalysisRun, AnalysisStage, AnalysisDecision } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

/** One record per subject per delivery; never expose another subject's evidence. */
export function createAnalysisMonitor(documents: DocumentStore, entries: readonly unknown[], now: () => number) {
  const runs = new Map<string, AnalysisRun>();
  for (const entry of entries) {
    const subject = (entry as { human_subject?: unknown } | null)?.human_subject;
    if (typeof subject !== 'string' || !subject) continue;
    let run = runs.get(subject);
    if (!run) {
      const at = new Date(now()).toISOString();
      run = { run_id: randomUUID(), human_subject: subject, started_at: at, updated_at: at,
        status: 'running', stage: 'collect', completed_stages: [], input_count: 0,
        normalized_count: 0, unmapped_count: 0, violation_count: 0, rule_hit_count: 0,
        decisions: [], error_code: null };
      runs.set(subject, run);
    }
    run.input_count += 1;
  }
  async function save(): Promise<void> {
    await Promise.all([...runs.values()].map(async (run) => {
      run.updated_at = new Date(now()).toISOString();
      await documents.set('security_analysis', run.run_id, { ...run,
        expire_at: documents.expiryFromNow(7 * 24 * 3600, Date.parse(run.started_at)),
      });
    }));
  }
  return {
    async stage(stage: AnalysisStage, update?: (run: AnalysisRun) => void) {
      for (const run of runs.values()) {
        if (run.stage !== stage && !run.completed_stages.includes(run.stage)) run.completed_stages.push(run.stage);
        run.stage = stage;
        update?.(run);
      }
      await save();
    },
    async decision(subject: string, decision: AnalysisDecision) {
      const run = runs.get(subject);
      if (!run) return;
      const index = run.decisions.findIndex((item) => item.finding_id === decision.finding_id);
      if (index < 0) run.decisions.push(decision); else run.decisions[index] = decision;
      await save();
    },
    async finish(failed = false) {
      for (const run of runs.values()) {
        run.status = failed ? 'failed' : 'completed';
        run.error_code = failed ? 'analysis_run_failed' : null;
        if (!failed && !run.completed_stages.includes(run.stage)) run.completed_stages.push(run.stage);
        if (failed) for (const decision of run.decisions) {
          if (['analyzing', 'queued', 'responding'].includes(decision.state)) { decision.state = 'failed'; decision.reason = 'analysis_run_failed'; }
        }
      }
      await save();
    },
  };
}
