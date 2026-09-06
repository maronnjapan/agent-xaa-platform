import { assertSecurityFindingView, type SecurityFindingView } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

/**
 * What Security Detection decided, for the person it decided about.
 *
 * Read out of the detector's own collection rather than asked for over HTTP, and that is
 * not a shortcut: T-SEC-08 makes the detector a one-way feed — applications log, it
 * reads, and nothing calls back, which `infra/tests/security-detection-inbound.sh`
 * enforces by refusing any invoker edge into it. A screen that had to reach it
 * synchronously would also be a screen that goes blank whenever it is redeploying. The
 * access matrix is the sanctioned way for one app to read another's rows (DEV-05), and
 * `security_findings/**` is now on this app's read list and on neither write list.
 *
 * This app holds no opinion about any of it. It does not score, it does not judge, and
 * it writes no sentence about what it read: every readable string in a finding was
 * written by the detector, or by the model it consulted, at the moment it judged
 * (RULE-54). The screen orders and folds them and nothing else.
 *
 * The subject is the query, not a filter applied afterwards: a person is shown the
 * findings whose `human_subject` is their own session's, and there is no parameter that
 * could widen that (RULE-56).
 *
 * The view is built field by field, never spread. The stored document also carries
 * `related_events` — the correlation ids of the log lines the finding was made from —
 * and `deviations`, which carry a `trace_id` each. Both are how the detector reaches
 * back into the audit trail, and neither belongs in a browser (RULE-38). Naming the
 * sixteen fields means a document that grows a seventeenth is invisible here until
 * somebody adds it deliberately, which is the same discipline `readAgentStatus` follows.
 */
export async function readFindingsFor(input: {
  documents: DocumentStore;
  humanSubject: string;
}): Promise<SecurityFindingView[]> {
  const rows = await input.documents.queryEqual<Record<string, unknown>>(
    'security_findings',
    [['human_subject', input.humanSubject]],
  );
  return rows
    .map((row) => viewOf(row.data))
    .filter((finding): finding is SecurityFindingView => finding !== null)
    // Newest first: the question a person opens this screen with is "what just happened".
    .sort((left, right) => right.detected_at.localeCompare(left.detected_at));
}

/**
 * One stored document, narrowed — or `null` when it is not a finding this screen can
 * show.
 *
 * Validated one row at a time, and a row that fails is dropped: the rest of a person's
 * findings are still worth showing, and a document the detector wrote in some other
 * shape is the detector's to fix, not a 500 on somebody's screen. Validating the list
 * as a whole would have made the opposite trade — one malformed row and the page is
 * gone.
 */
function viewOf(data: Record<string, unknown>): SecurityFindingView | null {
  const text = (key: string): string => (typeof data[key] === 'string' ? data[key] : '');
  const optionalText = (key: string): string | null => (typeof data[key] === 'string' ? data[key] : null);

  const analysis = data.analysis;
  const candidate = {
    finding_id: text('finding_id'),
    finding_type: text('finding_type'),
    agent_id: optionalText('agent_id'),
    human_subject: text('human_subject'),
    detected_at: text('created_at'),
    window_start: text('window_start'),
    window_end: text('window_end'),
    risk_score: typeof data.risk_score === 'number' ? Math.trunc(data.risk_score) : null,
    risk_level: optionalText('risk_level'),
    contributing_codes: Array.isArray(data.contributing_codes)
      ? data.contributing_codes.filter((code): code is string => typeof code === 'string')
      : [],
    review_status: text('review_status'),
    recommended_response: optionalText('recommended_response'),
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    analysis_source: optionalText('analysis_source'),
    analyzed_at: optionalText('analyzed_at'),
    analysis: isAnalysis(analysis)
      ? {
        deviation: {
          from_normal: String(analysis.deviation.from_normal),
          capability_consistency: String(analysis.deviation.capability_consistency),
        },
        judgement: {
          compromise_likelihood: String(analysis.judgement.compromise_likelihood),
          false_positive_likelihood: String(analysis.judgement.false_positive_likelihood),
          causality: String(analysis.judgement.causality),
        },
        impact: {
          scope: String(analysis.impact.scope),
          op_propagation: String(analysis.impact.op_propagation),
        },
      }
      : null,
  };
  try {
    assertSecurityFindingView(candidate);
  } catch {
    return null;
  }
  return candidate;
}

interface StoredAnalysis {
  deviation: Record<string, unknown>;
  judgement: Record<string, unknown>;
  impact: Record<string, unknown>;
}

function isAnalysis(value: unknown): value is StoredAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return ['deviation', 'judgement', 'impact']
    .every((aspect) => typeof candidate[aspect] === 'object' && candidate[aspect] !== null);
}
