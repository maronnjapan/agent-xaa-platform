import type { AiOutput, ResponseState } from '../ai/output.js';
import type { SecurityFinding } from '../correlate/finding.js';

/**
 * Where what is on the row came from: the model's answer, the risk level alone, or the
 * mechanical passes with no model asked at all.
 *
 * `rules` is what a LOW window gets. Nothing is wrong with it and nothing reasoned about
 * it, and both halves of that have to be sayable — a row that said nothing would be read
 * as a row still waiting for the model.
 */
export const ANALYSIS_SOURCES = ['model', 'fallback', 'rules'] as const;
export type AnalysisSource = (typeof ANALYSIS_SOURCES)[number];

/**
 * A finding as it is kept, which is the finding plus what the Security AI made of it.
 *
 * The recommendation alone used to be stored, and it is the one part of the model's
 * answer that needs no reading: `QUARANTINED` says what will happen and says nothing
 * about why. The other three aspects are the why, and a person asked to approve a
 * quarantine — or trying to understand one that already happened — has no other source
 * for it. They are kept in the model's own words, and the screen that shows them writes
 * no sentence of its own (RULE-54).
 */
export interface StoredFinding extends SecurityFinding {
  recommended_response?: ResponseState;
  confidence?: number;
  /** The four aspects of docs 09 §5.6. Absent when the model gave nothing usable. */
  analysis?: AiOutput;
  analysis_source?: AnalysisSource;
  analyzed_at?: string;
  /** Written by the review route when a person decided; never by the pipeline. */
  reviewer?: string;
}

/**
 * Which of two writes for the same window is the one that reasoned.
 *
 * `rules` is the mechanical passes and nothing more, so it never displaces an answer the
 * model stage produced — a `fallback` is at least a decision the response stage made.
 */
function analysed(finding: StoredFinding): boolean {
  return finding.analysis_source === 'model' || finding.analysis_source === 'fallback';
}

/**
 * One window's row, written a second time.
 *
 * A finding id is derived from the window and the agent so that a retry overwrites its
 * own earlier attempt. The pull loop then makes that the normal case rather than the
 * exceptional one: it delivers a log line at a time, so a ten-minute window arrives as
 * many batches, and a plain `set` of the last one would leave the row describing that
 * line alone — the codes of every earlier batch gone, and with them the model's answer,
 * the recommended response and whatever a person had already decided about it.
 *
 * So the evidence unions and the judgement is kept. The score and the level come from
 * whichever write saw more, because both were computed by the same scorer over a subset
 * of the same window and the larger subset is the better reading of it; `created_at`
 * stays at the first, because that is when the window was first reported and not when it
 * was last touched.
 */
export function mergeFinding(previous: StoredFinding | undefined, next: StoredFinding): StoredFinding {
  if (!previous) return next;

  const higher = (next.risk_score ?? 0) >= (previous.risk_score ?? 0) ? next : previous;
  const judgement = analysed(previous) && !analysed(next) ? previous : next;
  return {
    ...next,
    finding_type: higher.finding_type,
    risk_score: higher.risk_score,
    risk_level: higher.risk_level,
    created_at: earlier(previous.created_at, next.created_at),
    contributing_codes: [...new Set([...previous.contributing_codes, ...next.contributing_codes])].sort(),
    related_events: [...new Set([...previous.related_events, ...next.related_events])],
    deviations: unique([...(previous.deviations ?? []), ...(next.deviations ?? [])]),
    // A decision a person took outlives any later batch of the same window; only a row
    // nobody has looked at yet takes the new write's status.
    review_status: previous.review_status === 'none' ? next.review_status : previous.review_status,
    ...pickAnalysis(judgement),
    ...(previous.reviewer ? { reviewer: previous.reviewer } : {}),
  };
}

function pickAnalysis(from: StoredFinding): Partial<StoredFinding> {
  return {
    ...(from.recommended_response ? { recommended_response: from.recommended_response } : {}),
    ...(from.confidence === undefined ? {} : { confidence: from.confidence }),
    ...(from.analysis ? { analysis: from.analysis } : {}),
    ...(from.analysis_source ? { analysis_source: from.analysis_source } : {}),
    ...(from.analyzed_at ? { analyzed_at: from.analyzed_at } : {}),
  };
}

function earlier(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? left : right;
}

/** By value: two batches of the same window describe the same deviation twice. */
function unique<T>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
