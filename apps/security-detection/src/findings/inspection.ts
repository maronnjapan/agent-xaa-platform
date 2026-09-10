import type { SecurityInspectionCheck } from '@xaa/contracts';
import type { NormalizedEvent } from '../normalize/index.js';
import type { SecurityFinding } from '../correlate/finding.js';
import { groupByWindow, parseWindowKey } from '../rules/window.js';

export const INSPECTIONS_COLLECTION = 'security_inspections';

/**
 * The record that says the logs were read.
 *
 * Everything else this service writes is a report of something wrong. That is the right
 * shape for a detector and the wrong shape for the console in front of it: with no
 * finding there is no row, with no row the page is empty, and an empty page means either
 * 「見て、何もなかった」 or 「ログが届いていない」 with no way to tell which. The person
 * whose agent it is cannot debug the platform's plumbing, so the platform has to say.
 *
 * So one row per agent per window, holding counts and names and no judgement: which
 * mechanical passes ran, how many lines they read, which ones could not run, and what
 * they raised. `codes_raised` overlaps the finding's `contributing_codes` on purpose —
 * this row is readable on its own, and a finding may not exist to carry them.
 */
export interface StoredInspection {
  inspection_id: string;
  agent_id: string;
  human_subject: string;
  window_start: string;
  window_end: string;
  events_examined: number;
  checks_run: SecurityInspectionCheck[];
  checks_skipped: SecurityInspectionCheck[];
  codes_raised: string[];
  last_seen_at: string;
}

/**
 * The passes `runPipeline` makes over every event, named once.
 *
 * Kept beside the record rather than derived from the rule modules: this is what the
 * screen tells a person was done, so it has to change when somebody adds a pass, and a
 * list that is read by name is a list somebody has to come and edit. `rules/index.ts`
 * runs the middle five; `pipeline/index.ts` runs the first and the last.
 */
export const INSPECTION_CHECKS: readonly SecurityInspectionCheck[] = [
  'protocol_validation', 'token_rate', 'authorization', 'tool',
  'lifetime', 'isolation', 'authorization_ai', 'baseline_deviation',
];

/**
 * The two that measure an agent against its own baseline.
 *
 * Both are silent when the detector could not read one — `detectRuleHits` skips the
 * token pass and `deviationsByAgent` skips the deviation pass — and a silent pass and a
 * clean pass are not the same fact. Recording which it was is the difference between a
 * screen that says nothing was found and a screen that says nothing was looked for.
 */
export const BASELINE_DEPENDENT_CHECKS: readonly SecurityInspectionCheck[] = ['token_rate', 'baseline_deviation'];

/** One inspection per agent per window, from the batch the pipeline just finished. */
export function inspectionsFor(input: {
  events: readonly NormalizedEvent[];
  findings: readonly SecurityFinding[];
  hasBaseline(agentId: string): boolean;
  at: string;
}): StoredInspection[] {
  const codesByAgent = new Map<string, string[]>();
  for (const finding of input.findings) {
    if (!finding.agent_id) continue;
    codesByAgent.set(finding.agent_id, [
      ...(codesByAgent.get(finding.agent_id) ?? []), ...finding.contributing_codes,
    ]);
  }

  const inspections: StoredInspection[] = [];
  const grouped = groupByWindow(
    input.events.filter((event) => event.actor.agent_id !== null),
    (event) => event.actor.agent_id!,
    (event) => event.time,
  );
  for (const [key, events] of grouped) {
    const { windowStart, windowEnd, subject } = parseWindowKey(key);
    const withBaseline = input.hasBaseline(subject);
    inspections.push({
      inspection_id: inspectionId(windowStart, subject),
      agent_id: subject,
      // The events of one agent in one window all name the same person; the first that
      // names one at all decides, and an agent acting for nobody gets an empty string
      // exactly as a finding does.
      human_subject: events.find((event) => event.actor.human_subject)?.actor.human_subject ?? '',
      window_start: new Date(windowStart).toISOString(),
      window_end: new Date(windowEnd).toISOString(),
      events_examined: events.length,
      checks_run: INSPECTION_CHECKS.filter((check) => withBaseline || !BASELINE_DEPENDENT_CHECKS.includes(check)),
      checks_skipped: withBaseline ? [] : [...BASELINE_DEPENDENT_CHECKS],
      codes_raised: [...new Set(codesByAgent.get(subject) ?? [])].sort(),
      last_seen_at: input.at,
    });
  }
  return inspections;
}

/**
 * The same window and the same agent always give the same id, as a finding's does.
 *
 * The prefix keeps the two apart in a dump: reading `i_` where a finding id was expected
 * is a mistake somebody can see, and `f_` on a row that never judged anything is not.
 */
export function inspectionId(windowStart: number, agentId: string): string {
  return `i_${Math.floor(windowStart / 1000)}_${agentId}`;
}

/**
 * What the row becomes when a second batch lands in the same window.
 *
 * The pull loop delivers one log line at a time, so a ten-minute window arrives as many
 * batches and every one of them writes this row. Adding the counts rather than replacing
 * them is what makes 「N 件のログを点検した」 the truth about the window instead of the
 * truth about the last line of it.
 */
export function mergeInspection(previous: StoredInspection | undefined, next: StoredInspection): StoredInspection {
  if (!previous) return next;
  return {
    ...next,
    human_subject: next.human_subject || previous.human_subject,
    events_examined: previous.events_examined + next.events_examined,
    // A pass that ran once in this window ran; a pass is only skipped if it was skipped
    // every time, because a baseline that arrived late still means the agent was measured.
    checks_run: [...new Set([...previous.checks_run, ...next.checks_run])],
    checks_skipped: next.checks_skipped.filter((check) => previous.checks_skipped.includes(check)),
    codes_raised: [...new Set([...previous.codes_raised, ...next.codes_raised])].sort(),
  };
}
