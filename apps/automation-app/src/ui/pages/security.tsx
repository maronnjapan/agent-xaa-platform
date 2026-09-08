import { agentPagePath } from '../../agents/page-link.js';
import { ANALYSIS_STAGES, LEVEL_BOUNDARIES, REVIEW_CONFIDENCE_FLOOR, type AnalysisRun } from '@xaa/contracts';
import { Metric, formatTime } from '../components/visual.js';
import type { Element } from '../element.js';

const STAGE_LABELS: Record<string, string> = {
  collect: 'ログ受信',
  normalize: '正規化',
  validateProtocol: '違反確認',
  detectRules: 'ルール検知',
  correlate: '相関分析',
  score: 'スコア判定',
  analyze: 'AI分析',
  respond: '対応判定',
};
const REASONS: Record<string, string> = {
  below_ai_threshold: 'スコアがAI分析の閾値未満',
  awaiting_analysis: '分析の順番待ち',
  baseline_missing: '比較基準がないためAI分析を省略',
  ai_not_configured: 'AI接続が未設定',
  score_requires_ai: '閾値以上の検知がありAI分析を実行',
  ai_fallback: 'AIの有効な回答がなく代替判定。人の確認が必要',
  low_confidence: '確信度が基準未満のため人の確認が必要',
  disruptive_response: '停止を伴う推奨のため人の確認が必要',
  keep_active: '稼働継続を推奨',
  automatic_response: '確信度の基準を満たし、自動で状態変更を依頼',
  transition_failed: '状態変更の依頼に失敗',
  analysis_run_failed: '処理失敗。ログ配信側で再試行対象',
};
const STATES: Record<string, string> = {
  queued: '分析待ち',
  responding: '対応待ち',
  skipped: 'AI省略',
  analyzing: 'AI分析中',
  review: '人の確認待ち',
  responded: '判定済み',
  failed: '失敗',
};

export function AnalysisResults(props: { runs: readonly AnalysisRun[]; now: number }): Element {
  const decisions = props.runs.flatMap((run) => run.decisions);
  return (
    <div data-analysis-results="true">
      <div class="metric-grid">
        <Metric label="表示中の分析" value={props.runs.length} />
        <Metric
          label="処理中"
          value={props.runs.filter((run) => run.status === 'running').length}
          tone="blue"
        />
        <Metric
          label="人の確認待ち（実行時点）"
          value={decisions.filter((item) => item.state === 'review').length}
          tone="amber"
        />
        <Metric
          label="処理・対応の失敗"
          value={
            props.runs.filter(
              (run) => run.status === 'failed' || run.decisions.some((item) => item.state === 'failed'),
            ).length
          }
          tone="red"
        />
      </div>
      {props.runs.length === 0 ? (
        <div class="empty-state">
          <h2>分析記録はまだありません</h2>
          <p>
            自分に関連するログを分析サービスが受信すると表示されます。記録がない状態から、サービスの正常稼働は判断できません。
          </p>
        </div>
      ) : null}
      {props.runs.map((run) => (
        <article class="card analysis-run" data-status={run.status}>
          <header class="section-heading">
            <div>
              <span class="eyebrow">LOG ANALYSIS</span>
              <h2>
                {run.status === 'completed'
                  ? '分析完了'
                  : run.status === 'failed'
                    ? '分析失敗'
                    : `${STAGE_LABELS[run.stage]}中`}
              </h2>
            </div>
            <time datetime={run.updated_at}>最終記録 {formatTime(run.updated_at)} JST</time>
          </header>
          {run.status === 'running' && props.now - Date.parse(run.updated_at) > 60_000 ? (
            <p class="notice">60秒以上進捗が更新されていません。処理の遅延または中断の可能性があります。</p>
          ) : null}
          <ol class="pipeline">
            {ANALYSIS_STAGES.map((stage, index) => (
              <li
                data-state={
                  run.completed_stages.includes(stage) ? 'done' : run.stage === stage ? run.status : 'waiting'
                }
              >
                <span>{run.completed_stages.includes(stage) ? '✓' : index + 1}</span>
                {STAGE_LABELS[stage]}
              </li>
            ))}
          </ol>
          <div class="run-counts">
            <span>
              受信 <b>{run.input_count}</b>
            </span>
            <span>
              正規化 <b>{run.normalized_count}</b>
            </span>
            <span>
              未対応形式 <b>{run.unmapped_count}</b>
            </span>
            <span>
              違反 <b>{run.violation_count}</b>
            </span>
            <span>
              ルール一致 <b>{run.rule_hit_count}</b>
            </span>
          </div>
          {run.decisions.length === 0 ? (
            <p class="muted">
              {run.status === 'completed'
                ? 'この分析では検知結果が生成されず、AI分析は起動していません。'
                : '判定結果を待っています。'}
            </p>
          ) : null}
          {run.decisions.map((item) => (
            <section class="decision" data-level={item.level}>
              <div class="section-heading">
                <strong>{STATES[item.state] ?? item.state}</strong>
                <span class="risk-label">
                  {item.level} · {item.score}/100
                </span>
              </div>
              {/* `optimum` sits below `low`, which is what makes a browser paint a
                  high score red: on a risk scale the good end is zero. Without it the
                  meter reads green at 82/100 and contradicts the label beside it. */}
              <meter
                min="0"
                max="100"
                low={LEVEL_BOUNDARIES.medium}
                high={LEVEL_BOUNDARIES.high}
                optimum={0}
                value={item.score}
                aria-label="リスクスコア"
              />
              <p>{REASONS[item.reason] ?? item.reason}</p>
              <div class="code-list">
                {item.codes.map((code) => (
                  <code>{code}</code>
                ))}
              </div>
              <dl class="decision-facts">
                <dt>推奨する状態</dt>
                <dd>{item.response ?? '—'}</dd>
                <dt>AIの確信度</dt>
                <dd>{item.confidence === null ? '—' : `${Math.round(item.confidence * 100)}%`}</dd>
                <dt>状態変更の依頼</dt>
                <dd>
                  {item.transition === 'sent'
                    ? '受付済み'
                    : item.transition === 'failed'
                      ? '失敗'
                      : item.transition === 'refused'
                        ? '遷移対象外'
                        : '未実施'}
                </dd>
              </dl>
              <details>
                <summary>識別情報</summary>
                <p>
                  Finding: <code>{item.finding_id}</code>
                </p>
                <p>
                  Agent:{' '}
                  {item.agent_id ? (
                    <a href={agentPagePath(item.agent_id)}>{item.agent_id}</a>
                  ) : (
                    '複数Agentに関連'
                  )}
                </p>
              </details>
            </section>
          ))}
          {run.error_code ? (
            <p class="notice">処理に失敗しました。再配信された場合は別の分析として記録されます。</p>
          ) : null}
          <small class="muted">実行 ID: {run.run_id}</small>
        </article>
      ))}
    </div>
  );
}
export function SecurityPage(props: { runs: readonly AnalysisRun[]; now: number }): Element {
  return (
    <main class="security-page" data-page="security">
      <header class="page-heading">
        <div>
          <span class="eyebrow">OBSERVABILITY</span>
          <h1>ログ分析モニター</h1>
          <p class="lead">ログの受信から、AI分析を起動した理由、対応の判断まで。</p>
        </div>
        <button type="button" data-action="monitor-refresh">
          更新
        </button>
      </header>
      <section class="card policy-guide">
        <h2>プラットフォームの判断条件</h2>
        <p>
          ログ配信を受けてルール検知・相関分析を実行し、検知結果のスコアが {LEVEL_BOUNDARIES.medium}{' '}
          以上でAI分析を起動します。Agentの比較基準とAI接続が必要です。
        </p>
        <div class="risk-bands">
          <span>LOW 0–{LEVEL_BOUNDARIES.medium - 1}</span>
          <span>
            MEDIUM {LEVEL_BOUNDARIES.medium}–{LEVEL_BOUNDARIES.high - 1}
          </span>
          <span>
            HIGH {LEVEL_BOUNDARIES.high}–{LEVEL_BOUNDARIES.critical - 1}
          </span>
          <span>CRITICAL {LEVEL_BOUNDARIES.critical}–100</span>
        </div>
        <p>
          AIの確信度が {REVIEW_CONFIDENCE_FLOOR * 100}%
          未満、隔離・失効・破棄の推奨、AI回答の代替判定は、人の確認を待ちます。状態変更はLifecycle
          Managerへ依頼します。
        </p>
      </section>
      <div class="monitor-toolbar">
        <label>
          <input type="checkbox" data-monitor-auto="true" checked /> 5秒ごとに更新
        </label>
        <span role="status" data-monitor-status="true">
          最新30件・自分に関連する分析のみ。判定は各実行時点の記録です。
        </span>
      </div>
      <AnalysisResults {...props} />
    </main>
  );
}
