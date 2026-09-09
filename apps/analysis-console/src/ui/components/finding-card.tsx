import type {
  SecurityAnalysisSource, SecurityFindingType, SecurityFindingView,
  SecurityResponseState, SecurityReviewStatus, SecurityRiskLevel,
} from '@xaa/contracts';
import type { Element } from '../element.js';

/**
 * One judgement, laid out.
 *
 * The words a person reads here come from two places and no third. The captions below
 * name parts of the screen — 「推奨する対応」 is a heading, not a claim about anything
 * that happened. The tables translate closed vocabularies the detector sends, the way
 * the record view already turns a check's `blocked` into 「不可」: naming a value in the
 * reader's language is not interpreting it, and the lists are pinned to the detector's
 * own in `@xaa/contracts`.
 *
 * Everything else is printed exactly as it arrived. The four aspects were written by the
 * model at the moment it judged, the codes are the detector's, and this file composes no
 * sentence about any of them (RULE-54). A screen that summarised 「危険です」 over a
 * score of 62 would be a second opinion about an agent, from the one component in the
 * platform that is not allowed to have one.
 */

const RISK_LEVELS: Readonly<Record<SecurityRiskLevel, string>> = {
  LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '重大',
};

const FINDING_TYPES: Readonly<Record<SecurityFindingType, string>> = {
  anomalous_agent_activity: '通常と異なる挙動',
  potential_agent_compromise: '侵害の可能性',
  cross_agent_lateral_movement: '他の Agent への横移動',
  platform_wide_isolation_breach: '分離境界の突破',
};

const RESPONSE_STATES: Readonly<Record<SecurityResponseState, string>> = {
  ACTIVE: 'そのまま続行',
  SUSPICIOUS: '注視',
  QUARANTINED: '隔離',
  REVOKED: '失効',
  DESTROYED: '破棄',
};

const REVIEW_STATUSES: Readonly<Record<SecurityReviewStatus, string>> = {
  none: '不要（自動で対応済み）',
  pending: '確認待ち',
  approved: '承認済み',
  rejected: '却下済み',
};

const ANALYSIS_SOURCES: Readonly<Record<SecurityAnalysisSource, string>> = {
  model: '分析エージェントの判断',
  fallback: '分析が得られず、リスク値だけで決めた既定の対応',
  rules: '機械的なチェックのみ。分析エージェントは呼ばれていない',
};

export const FINDING_NO_ANALYSIS =
  '分析エージェントから読み取れる回答が返らなかったため、四つの観点はありません。';
export const FINDING_NOT_ANALYSED = 'まだ分析されていません。';
/**
 * The end of the road, said as an end rather than as a wait.
 *
 * 「まだ」 above is a row on its way to the model. This one is not on its way anywhere:
 * either it scored below the line where the model is asked, or the model stage could not
 * run for it — and in both cases the codes above are the whole of what is known and no
 * fourth aspect is coming. A person who read 「まだ」 here would keep the page open
 * waiting for it.
 *
 * Which of the two it was is deliberately not stated. The detector sends one value for
 * both, and a screen that guessed at the reason from the risk level beside it would be
 * writing a sentence nothing had decided (RULE-54).
 */
export const FINDING_RULES_ONLY =
  '機械的なチェックの結果だけです。分析エージェントには渡っていないため、四つの観点はありません。';

/** A count between 0 and 1 read as a percentage; the value itself stays in the title. */
function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * The recorded instant, served as it was recorded.
 *
 * The `datetime` attribute is the record and never changes. The layout's inline script
 * re-states the text in the reader's own zone once the browser has the page; with no
 * script the reader keeps the UTC instant, which is still correct.
 */
function Instant(props: { at: string; className?: string }): Element {
  return <time className={props.className} dateTime={props.at} title={props.at}>{props.at}</time>;
}

/** Why there are no four aspects, which is a different sentence for each of the three. */
function noAnalysisNote(source: SecurityAnalysisSource | null): string {
  if (source === null) return FINDING_NOT_ANALYSED;
  return source === 'rules' ? FINDING_RULES_ONLY : FINDING_NO_ANALYSIS;
}

export function FindingCard(props: { finding: SecurityFindingView }): Element {
  const finding = props.finding;
  const analysis = finding.analysis;
  return (
    <li
      className="finding"
      data-finding-id={finding.finding_id}
      data-risk-level={finding.risk_level ?? ''}
      data-review-status={finding.review_status}
    >
      <p className="finding-head">
        <span className="finding-level" data-field="risk_level">
          {finding.risk_level ? RISK_LEVELS[finding.risk_level] : '—'}
        </span>
        <span data-field="finding_type">{FINDING_TYPES[finding.finding_type]}</span>
        <span data-field="risk_score">{finding.risk_score === null ? '—' : `スコア ${finding.risk_score}`}</span>
        <Instant at={finding.detected_at} className="finding-at" />
      </p>

      <dl className="finding-facts">
        <dt>見ていた区間</dt>
        <dd data-field="window">
          <Instant at={finding.window_start} />
          〜
          <Instant at={finding.window_end} />
        </dd>
        <dt>反応したルール</dt>
        <dd data-field="contributing_codes">
          {finding.contributing_codes.length === 0 ? '—' : finding.contributing_codes.join(' / ')}
        </dd>
      </dl>

      {analysis
        ? (
          <dl className="finding-analysis" data-field="analysis">
            <dt>通常との差</dt>
            <dd data-aspect="from_normal">{analysis.deviation.from_normal}</dd>
            <dt>権限との整合</dt>
            <dd data-aspect="capability_consistency">{analysis.deviation.capability_consistency}</dd>
            <dt>侵害の可能性</dt>
            <dd data-aspect="compromise_likelihood">{analysis.judgement.compromise_likelihood}</dd>
            <dt>誤検知の可能性</dt>
            <dd data-aspect="false_positive_likelihood">{analysis.judgement.false_positive_likelihood}</dd>
            <dt>関連する出来事のつながり</dt>
            <dd data-aspect="causality">{analysis.judgement.causality}</dd>
            <dt>影響の範囲</dt>
            <dd data-aspect="scope">{analysis.impact.scope}</dd>
            <dt>他の OP への波及</dt>
            <dd data-aspect="op_propagation">{analysis.impact.op_propagation}</dd>
          </dl>
        )
        : (
          <p className="finding-note" data-field="analysis" data-state="none">
            {noAnalysisNote(finding.analysis_source)}
          </p>
        )}

      <dl className="finding-outcome">
        <dt>推奨する対応</dt>
        <dd data-field="recommended_response">
          {finding.recommended_response ? RESPONSE_STATES[finding.recommended_response] : '—'}
        </dd>
        <dt>確信度</dt>
        <dd data-field="confidence" title={finding.confidence === null ? '' : String(finding.confidence)}>
          {finding.confidence === null ? '—' : percent(finding.confidence)}
        </dd>
        <dt>判断の出どころ</dt>
        <dd data-field="analysis_source">
          {finding.analysis_source ? ANALYSIS_SOURCES[finding.analysis_source] : '—'}
        </dd>
        <dt>人による確認</dt>
        <dd data-field="review_status">{REVIEW_STATUSES[finding.review_status]}</dd>
      </dl>
    </li>
  );
}
