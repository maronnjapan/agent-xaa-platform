import type { ActivityRecord, ActivityRecordHop } from '@xaa/contracts';

/**
 * The mark beside one step of the execution log, read off what its publisher wrote.
 *
 * A record carries no `outcome` of its own — the event it travels on does — and on the
 * agent screen the records arrive from the checkpoint with no event around them. What
 * they do carry is a verdict on every check, an outcome on every hop, and a section the
 * Runtime names `failure` when a call stopped. Those are the publisher's own words for
 * how the step went, and a mark chosen from them is a mark, not a sentence (RULE-54):
 * the headline beside it still says what happened, in the Runtime's words.
 *
 * The order is the order of seriousness the timeline already uses: a step something
 * refused reads as blocked before it reads as anything else, a step that stopped reads
 * as failed, a step that came back reads as success, and a step that moved nothing —
 * the agent deciding it was done, or answering unreadably — is information.
 */
export type StepVerdict = 'blocked' | 'failed' | 'success' | 'info';

export function stepVerdict(record: Pick<ActivityRecord, 'checks' | 'hops' | 'sections'>): StepVerdict {
  const checks = record.checks ?? [];
  const hops = record.hops ?? [];
  if (checks.some((check) => check.result === 'blocked') || hops.some((hop) => hop.outcome === 'blocked')) return 'blocked';
  if (checks.some((check) => check.result === 'failed') || hops.some((hop) => hop.outcome === 'failed')
    || record.sections.some((section) => section.id === 'failure')) return 'failed';
  if (hops.some((hop) => hop.outcome === 'success')) return 'success';
  return 'info';
}

/** One box on the route, and the exchange that reached it. */
export interface RouteStop {
  node: string;
  /** The hop that arrived here; absent on the first box of a run of hops. */
  arrival?: ActivityRecordHop;
}

/**
 * The boxes a step passed through, in order, with the exchange between each pair.
 *
 * Four hops of one tool call touch three boxes — runtime, OP, runtime, AS, runtime,
 * API, runtime — and drawing each hop as its own pair of boxes would show the Agent
 * Runtime six times. Consecutive hops that hand over where the last one landed are
 * joined; a hop that starts somewhere else begins a new run.
 */
export function routeStops(hops: readonly ActivityRecordHop[]): RouteStop[] {
  const stops: RouteStop[] = [];
  for (const hop of hops) {
    const last = stops[stops.length - 1];
    if (!last || last.node !== hop.from) stops.push({ node: hop.from });
    stops.push({ node: hop.to, arrival: hop });
  }
  return stops;
}

/** How the checks of a step came out, counted. */
export function checkCounts(record: Pick<ActivityRecord, 'checks'>): Record<'passed' | 'blocked' | 'failed' | 'skipped', number> {
  const counts = { passed: 0, blocked: 0, failed: 0, skipped: 0 };
  for (const check of record.checks ?? []) counts[check.result] += 1;
  return counts;
}
