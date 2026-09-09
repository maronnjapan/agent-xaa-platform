import {
  LEVEL_BOUNDARIES, REVIEW_CONFIDENCE_FLOOR, REVIEW_REQUIRED_RESPONSES, type AnalysisDecision,
} from '@xaa/contracts/security-monitoring';

/**
 * The route one finding took through the platform's decision logic, as a list of gates.
 *
 * Security Detection records a `reason` for every state a finding passes through, and
 * each reason is reached by exactly one path through the same questions: is the score
 * above the AI threshold, is there a baseline to compare against, is a model
 * configured, did it answer, was it confident, does its recommendation stop the agent,
 * does it want the agent kept as it is. This file turns the recorded reason back into
 * that path, so a person can see not only what was decided but which question decided
 * it — and which questions were never asked.
 *
 * Nothing here judges the finding. The answers are read off values the detector
 * wrote (`reason`, `state`, `score`, `confidence`, `response`, `transition`), and the
 * thresholds are the same constants the detector decides with (RULE-54).
 */

export type GateAnswer = 'yes' | 'no' | 'pending' | 'unreached';

export const GATE_IDS = ['threshold', 'baseline', 'ai_configured', 'answered', 'confidence', 'disruptive', 'keep'] as const;
export type GateId = (typeof GATE_IDS)[number];

export interface TraceGate {
  id: GateId;
  question: string;
  answer: GateAnswer;
  /** The value the answer was read from, when the record carries one. */
  evidence: string;
}

export type EndTone = 'skip' | 'review' | 'continue' | 'respond' | 'failed' | 'pending';

export interface TraceEnd {
  id: 'skip' | 'review' | 'continue' | 'respond' | 'failed' | 'pending' | 'analyze';
  label: string;
  tone: EndTone;
}

export interface DecisionTrace {
  gates: readonly TraceGate[];
  end: TraceEnd;
  /** Flowchart node ids on the path, in order; the last one is where the finding is. */
  path: readonly string[];
  /** The node the finding is waiting at, when it has not reached an end. */
  current: string | null;
}

const CONFIDENCE_PERCENT = Math.round(REVIEW_CONFIDENCE_FLOOR * 100);

const QUESTIONS: Readonly<Record<GateId, string>> = {
  threshold: `スコアが ${LEVEL_BOUNDARIES.medium} 以上か`,
  baseline: 'Agent の比較基準（baseline）があるか',
  ai_configured: 'AI 接続が設定されているか',
  answered: 'AI の回答を読み取れたか',
  confidence: `確信度が ${CONFIDENCE_PERCENT}% 以上か`,
  disruptive: `推奨が ${REVIEW_REQUIRED_RESPONSES.join('・')} のどれかか`,
  keep: '推奨が ACTIVE（そのまま続行）か',
};

/**
 * Each recorded reason, as the answers that lead to it.
 *
 * The answers are listed in gate order and stop where the path stops; the gate after
 * the last answer is where an unfinished finding is waiting, and every later gate was
 * never reached. `end` is what the path arrives at, or `null` while it is still going.
 */
const ROUTES: Readonly<Record<string, { answers: readonly GateAnswer[]; end: TraceEnd | null }>> = {
  below_ai_threshold: { answers: ['no'], end: { id: 'skip', label: 'AI 分析を省略（スコアが閾値未満）', tone: 'skip' } },
  awaiting_analysis: { answers: ['yes'], end: null },
  baseline_missing: { answers: ['yes', 'no'], end: { id: 'skip', label: 'AI 分析を省略（比較基準がない）', tone: 'skip' } },
  ai_not_configured: { answers: ['yes', 'yes', 'no'], end: { id: 'skip', label: 'AI 分析を省略（AI 接続がない）', tone: 'skip' } },
  score_requires_ai: { answers: ['yes', 'yes', 'yes'], end: null },
  ai_fallback: { answers: ['yes', 'yes', 'yes', 'no'], end: { id: 'review', label: '人の確認待ち（代替判定）', tone: 'review' } },
  low_confidence: { answers: ['yes', 'yes', 'yes', 'yes', 'no'], end: { id: 'review', label: '人の確認待ち（確信度が基準未満）', tone: 'review' } },
  disruptive_response: { answers: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes'], end: { id: 'review', label: '人の確認待ち（停止を伴う推奨）', tone: 'review' } },
  keep_active: { answers: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'yes'], end: { id: 'continue', label: '稼働を継続', tone: 'continue' } },
  automatic_response: { answers: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no'], end: { id: 'respond', label: '状態変更を Lifecycle Manager に依頼', tone: 'respond' } },
  transition_failed: { answers: ['yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no'], end: { id: 'failed', label: '状態変更の依頼に失敗', tone: 'failed' } },
};

/** The stages every finding passed through before there was anything to decide. */
export const STAGE_NODES = ['collect', 'normalize', 'validate', 'rules', 'correlate', 'score'] as const;

/** Where the AI node sits in the gate order: after the third gate has said yes. */
const AI_AFTER_GATE = 3;

export function traceDecision(decision: Pick<AnalysisDecision, 'reason' | 'state' | 'score' | 'level' | 'confidence' | 'response' | 'transition'>): DecisionTrace {
  const route = ROUTES[decision.reason];
  const answers = route?.answers ?? [];
  const inProgress = route !== undefined && route.end === null;
  const failed = decision.state === 'failed' && route?.end?.tone !== 'failed';

  const gates: TraceGate[] = GATE_IDS.map((id, index) => ({
    id,
    question: QUESTIONS[id],
    answer: answers[index] ?? (inProgress && index === answers.length ? 'pending' : 'unreached'),
    evidence: evidenceFor(id, decision),
  }));

  // A decision exists only once the six stages before it have run, so they are on
  // every path; what varies is where the path goes after the score.
  const path: string[] = [...STAGE_NODES];
  for (let index = 0; index < GATE_IDS.length; index += 1) {
    if (index === AI_AFTER_GATE && answers[index - 1] === 'yes') path.push('analyze');
    if (index < answers.length || (inProgress && index === answers.length)) path.push(GATE_IDS[index]!);
  }
  if (inProgress && answers.length === AI_AFTER_GATE) path.push('analyze');

  let end: TraceEnd;
  if (failed) {
    end = { id: 'failed', label: '分析処理が失敗', tone: 'failed' };
  } else if (!route) {
    end = { id: 'pending', label: decision.reason, tone: 'pending' };
  } else if (route.end === null) {
    end = answers.length === AI_AFTER_GATE
      ? { id: 'analyze', label: 'AI 分析中', tone: 'pending' }
      : { id: 'pending', label: '分析の順番待ち', tone: 'pending' };
  } else if (route.end.tone === 'respond' && decision.state === 'responding') {
    end = { ...route.end, label: '状態変更を依頼中', tone: 'pending' };
  } else {
    end = route.end;
  }
  if (end.tone !== 'pending' && end.id !== 'pending') path.push(end.id);

  const current = end.tone === 'pending'
    ? (end.id === 'analyze' ? 'analyze' : gates.find((gate) => gate.answer === 'pending')?.id ?? end.id)
    : null;
  return { gates, end, path, current };
}

function evidenceFor(id: GateId, decision: Pick<AnalysisDecision, 'score' | 'level' | 'confidence' | 'response'>): string {
  switch (id) {
    case 'threshold': return `${decision.score} / 100 · ${decision.level}`;
    case 'confidence': return decision.confidence === null ? '' : `${Math.round(decision.confidence * 100)}%`;
    case 'disruptive':
    case 'keep': return decision.response ?? '';
    default: return '';
  }
}

/** What the Lifecycle Manager answered, in the words the screen uses for it. */
export const TRANSITION_LABELS: Readonly<Record<string, string>> = {
  sent: '受付済み',
  failed: '失敗',
  refused: '遷移対象外',
};
