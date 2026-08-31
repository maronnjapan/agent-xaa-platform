import { generateJson } from '@xaa/vertex';
import { dailyReportSchema } from '../schemas/index.js';
import type { WorkSignal } from '../signals/work-signal-source.js';
import type { Generate } from '../automation/suggestions.js';

export interface DailyReport { title: string; body: string }

/**
 * Writes a daily report from the user's own work logs, when they ask for one.
 *
 * There is no schedule behind this: no Cloud Scheduler job, and the route is not under
 * `/internal/`, so nothing but a signed-in person can trigger it. A report generated
 * on a timer would be an agent acting without a request, which is the pattern this
 * platform is built to make impossible.
 */
export async function buildDailyReport(input: {
  signals: readonly WorkSignal[];
  generate?: Generate;
}): Promise<DailyReport | null> {
  const generate = input.generate ?? (<T>(params: Parameters<typeof generateJson>[0]) => generateJson<T>(params));
  const logs = input.signals.filter((signal) => signal.source_kind === 'work_log');
  if (logs.length === 0) return null;
  return generate<DailyReport>({
    prompt: `次の作業記録から日報を作ってください。\n${JSON.stringify(logs)}`,
    schema: dailyReportSchema,
    maxOutputTokens: 2048,
    temperature: 0.2,
  });
}
