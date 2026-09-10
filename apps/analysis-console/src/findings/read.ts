import {
  assertSecurityFindingView, assertSecurityInspectionView,
  type SecurityFindingView, type SecurityInspectionView,
} from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

/**
 * What Security Detection decided, for the person it decided about.
 *
 * Read out of the detector's own collection rather than asked for over HTTP, and that is
 * not a shortcut: T-SEC-08 makes the detector a one-way feed — applications log, it
 * reads, and nothing calls back, which `infra/tests/security-detection-inbound.sh`
 * enforces by refusing any invoker edge into it. A console that had to reach it
 * synchronously would also be a console that goes blank whenever the detector is
 * redeploying. The access matrix is the sanctioned way for one app to read another's
 * rows (DEV-05), and `security_findings/**` is on this app's read list and on no write
 * list anywhere in it.
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
 * somebody adds it deliberately.
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

/**
 * The agent's own state, for the heading each group of findings sits under.
 *
 * A judgement is easier to read next to what became of the agent: 「隔離」 beside a
 * CRITICAL finding says the response was taken, and 「実行中」 beside one says it has
 * not been. The registration is read by id — the ids come from the findings, which this
 * app has already narrowed to the session's subject — and the state is compared with
 * that subject again before it is used. A registration for somebody else's agent means
 * the detector and the Provisioner disagree about who owns it, and the honest answer
 * then is to show no state rather than the wrong one.
 *
 * An agent whose registration is gone is not an error: an agent that expired or was
 * destroyed takes its `meta` with it, while its findings stay. Those get no state.
 */
export async function readAgentStates(input: {
  documents: DocumentStore;
  agentIds: readonly string[];
  humanSubject: string;
}): Promise<ReadonlyMap<string, string>> {
  const states = new Map<string, string>();
  for (const agentId of input.agentIds) {
    const meta = await input.documents
      .get<{ human_subject?: string; status?: string }>('agents', `${agentId}__meta`)
      .catch(() => undefined);
    if (!meta || meta.human_subject !== input.humanSubject) continue;
    if (typeof meta.status === 'string') states.set(agentId, meta.status);
  }
  return states;
}

/**
 * That the analyser read this person's logs, whether or not it found anything.
 *
 * A finding is only written when something tripped, so a well-behaved agent leaves none
 * and the screen it belongs to is blank. Blank has two meanings — 「見て、何もなかった」
 * and 「ログが届いていない」 — and a person cannot tell them apart from the outside, nor
 * do anything about the second if they could. These rows are the detector saying which
 * it was: how many lines it read, which mechanical passes it made over them, and which
 * ones it could not make.
 *
 * Read the same way findings are, for the same reasons: out of the detector's collection
 * over the access matrix (DEV-05), narrowed by the session's own subject and nothing
 * wider (RULE-56), and built field by field so the stored document can grow one this
 * screen does not show (RULE-38).
 */
export async function readInspectionsFor(input: {
  documents: DocumentStore;
  humanSubject: string;
}): Promise<SecurityInspectionView[]> {
  const rows = await input.documents.queryEqual<Record<string, unknown>>(
    'security_inspections',
    [['human_subject', input.humanSubject]],
  );
  return rows
    .map((row) => inspectionOf(row.data))
    .filter((inspection): inspection is SecurityInspectionView => inspection !== null)
    .sort((left, right) => right.window_start.localeCompare(left.window_start));
}

/** One stored inspection, narrowed — or `null` when it is not one this screen can show. */
function inspectionOf(data: Record<string, unknown>): SecurityInspectionView | null {
  const text = (key: string): string => (typeof data[key] === 'string' ? data[key] : '');
  const list = (key: string): string[] => (Array.isArray(data[key])
    ? (data[key] as unknown[]).filter((item): item is string => typeof item === 'string')
    : []);
  const candidate = {
    inspection_id: text('inspection_id'),
    agent_id: text('agent_id'),
    human_subject: text('human_subject'),
    window_start: text('window_start'),
    window_end: text('window_end'),
    events_examined: typeof data.events_examined === 'number' ? Math.trunc(data.events_examined) : 0,
    checks_run: list('checks_run'),
    checks_skipped: list('checks_skipped'),
    codes_raised: list('codes_raised'),
    last_seen_at: text('last_seen_at'),
  };
  try {
    assertSecurityInspectionView(candidate);
  } catch {
    return null;
  }
  return candidate;
}
