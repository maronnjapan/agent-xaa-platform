import { useMonitor } from '../hooks/use-monitor.js';
import { agentPagePath } from '../../agents/page-link.js';
import { ANALYSIS_STAGES, LEVEL_BOUNDARIES, REVIEW_CONFIDENCE_FLOOR, type AnalysisRun } from '@xaa/contracts/security-monitoring';
import { Metric, formatTime, formatDuration } from '../components/visual.js';
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
const FACTOR_LABELS: Record<string, string> = {
  protocol_violation: 'プロトコル違反', authorization_violation: '認可違反',
  authorization_ai_anomaly: '認可AIの異常', behavior_deviation: '通常動作からの逸脱',
  request_rate: 'リクエスト頻度', resource_sensitivity: '機密リソースへのアクセス',
  cross_agent_activity: 'Agent間のアクセス', dpop_failure: 'DPoP検証失敗',
  delegation_mismatch: '委任の不一致', signing_key_misuse: '署名鍵の不正使用',
  privilege_escalation_attempt: '権限昇格の試行', agent_expiration_violation: '有効期限違反',
  isolation_boundary_violation: '隔離境界の違反',
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
      <div className="metric-grid">
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
        <div className="empty-state">
          <h2>分析記録はまだありません</h2>
          <p>
            自分に関連するログを分析サービスが受信すると表示されます。記録がない状態から、サービスの正常稼働は判断できません。
          </p>
        </div>
      ) : null}
      {props.runs.map((run) => (
        <article key={run.run_id} className="card analysis-run" data-status={run.status}>
          <header className="section-heading">
            <div>
              <span className="eyebrow">LOG ANALYSIS</span>
              <h2>
                {run.status === 'completed'
                  ? '分析完了'
                  : run.status === 'failed'
                    ? '分析失敗'
                    : `${STAGE_LABELS[run.stage]}中`}
              </h2>
            </div>
            <time dateTime={run.updated_at}>最終記録 {formatTime(run.updated_at)} JST</time>
          </header>
          {run.status === 'running' && props.now - Date.parse(run.updated_at) > 60_000 ? (
            <p className="notice">60秒以上進捗が更新されていません。処理の遅延または中断の可能性があります。</p>
          ) : null}
          <div className="analysis-progress">
            <span>{run.completed_stages.length} / {ANALYSIS_STAGES.length} 段階完了</span>
            <span>経過 {formatDuration((run.status === 'running' ? props.now : Date.parse(run.updated_at)) - Date.parse(run.started_at))}</span>
          </div>
          <progress className="stage-progress" value={run.completed_stages.length} max={ANALYSIS_STAGES.length} aria-label="分析の進捗" />
          <ol className="pipeline">
            {ANALYSIS_STAGES.map((stage, index) => (
              <li key={stage}
                data-state={
                  run.completed_stages.includes(stage) ? 'done' : run.stage === stage ? run.status : 'waiting'
                }
              >
                <span>{run.completed_stages.includes(stage) ? '✓' : index + 1}</span>
                {STAGE_LABELS[stage]}
                <small>{run.stage_durations_ms?.[stage] !== undefined
                  ? formatDuration(run.stage_durations_ms[stage]!)
                  : run.stage === stage && run.status === 'running' && run.stage_started_at
                    ? `${formatDuration(props.now - Date.parse(run.stage_started_at))} 経過`
                    : run.completed_stages.includes(stage) ? '完了' : run.stage === stage && run.status === 'failed' ? '失敗' : '待機'}</small>
              </li>
            ))}
          </ol>
          <div className="run-counts">
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
            <p className="muted">
              {run.status === 'completed'
                ? 'この分析では検知結果が生成されず、AI分析は起動していません。'
                : '判定結果を待っています。'}
            </p>
          ) : null}
          {run.decisions.map((item) => (
            <section key={item.finding_id} className="decision" data-level={item.level}>
              <div className="section-heading">
                <strong>{STATES[item.state] ?? item.state}</strong>
                <span className="risk-label">
                  {item.level} · {item.score}/100
                </span>
              </div>
              {/* `optimum` sits below `low`, which is what makes a browser paint a
                  high score red: on a risk scale the good end is zero. Without it the
                  meter reads green at 82/100 and contradicts the label beside it. */}
              <meter
                min={0}
                max={100}
                low={LEVEL_BOUNDARIES.medium}
                high={LEVEL_BOUNDARIES.high}
                optimum={0}
                value={item.score}
                aria-label="リスクスコア"
              />
              <div className="decision-route" aria-label="この検知の判断経路">
                <span><small>検知スコア</small><b>{item.score} / 100</b></span>
                <span aria-hidden="true">→</span>
                <span><small>AI分析</small><b>{item.state === 'skipped' ? '省略' : item.state === 'queued' ? '待機' : item.state === 'analyzing' ? '実行中' : item.reason === 'analysis_run_failed' ? '中断' : '実施'}</b></span>
                <span aria-hidden="true">→</span>
                <span><small>対応</small><b>{STATES[item.state] ?? item.state}</b></span>
              </div>
              <p>{REASONS[item.reason] ?? item.reason}</p>
              {item.score_breakdown ? (
                <details className="score-details">
                  <summary>スコアの算出根拠</summary>
                  {item.score_breakdown.critical_override ? <p className="notice">委任の不一致または署名鍵の不正使用を検知したため、加算結果によらず100点です。</p>
                    : <p className="muted">要因ごとに「該当数 × 重み」を上限まで加算し、合計を100点で制限します。</p>}
                  <p className="muted">該当数は検知コードの数です。リソースへの加点は対象へのアクセス有無で決まります。</p>
                  <div className="table-scroll"><table>
                    <thead><tr><th>要因</th><th>該当数 × 重み</th><th>上限</th><th>{item.score_breakdown.critical_override ? '通常計算' : '加点'}</th></tr></thead>
                    <tbody>{item.score_breakdown.contributions.map((part) => <tr key={part.factor}>
                      <th>{FACTOR_LABELS[part.factor] ?? part.factor}</th><td>{part.count} × {part.per_event}</td><td>{part.cap}</td>
                      <td><b>{part.points}</b><span className="contribution-bar" style={{ width: `${part.points}%` }} /></td>
                    </tr>)}</tbody>
                  </table></div>
                  {item.score_breakdown.unmapped_count > 0 ? <p className="notice">スコアへの対応がないコード: {item.score_breakdown.unmapped_count}件</p> : null}
                </details>
              ) : <p className="muted">この記録にはスコア内訳がありません。</p>}
              <div className="code-list">
                {item.codes.map((code) => (
                  <code key={code}>{code}</code>
                ))}
              </div>
              <dl className="decision-facts">
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
            <p className="notice">処理に失敗しました。再配信された場合は別の分析として記録されます。</p>
          ) : null}
          <small className="muted">実行 ID: {run.run_id}</small>
        </article>
      ))}
    </div>
  );
}
export function SecurityPage(props: { runs: readonly AnalysisRun[]; now: number }): Element {
  const monitor = useMonitor('/api/security/analysis', { runs: props.runs, now: props.now });
  return (
    <main className="security-page" data-page="security">
      <header className="page-heading">
        <div>
          <span className="eyebrow">OBSERVABILITY</span>
          <h1>ログ分析モニター</h1>
          <p className="lead">ログの受信から、AI分析を起動した理由、対応の判断まで。</p>
        </div>
        <button type="button" data-action="monitor-refresh" disabled={monitor.busy} onClick={() => void monitor.refresh()}>
          更新
        </button>
      </header>
      <section className="card policy-guide">
        <div className="section-heading"><h2>プラットフォームの判断条件</h2><span className="eyebrow">DECISION FLOW</span></div>
        <ol className="policy-flow">
          <li><span className="flow-number">01</span><h3>ログから検知</h3><p>受信 → 違反・ルール確認 → 相関分析</p><small>通常ログも記録。検知なしならAIは起動しません。</small></li>
          <li><span className="flow-number">02</span><h3>AIの起動を判断</h3><p>スコア {LEVEL_BOUNDARIES.medium} 以上</p><small>比較基準とAI接続がそろった場合に分析します。</small></li>
          <li><span className="flow-number">03</span><h3>対応を選ぶ</h3><p>確信度・推奨状態を確認</p><small>継続、自動で状態変更、人の確認待ちに分岐します。</small></li>
        </ol>
        <div className="risk-bands">
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
      <div className="monitor-toolbar">
        <label>
          <input type="checkbox" data-monitor-auto="true" checked={monitor.auto} onChange={(event) => monitor.setAuto(event.target.checked)} /> 5秒ごとに更新
        </label>
        <span role="status" data-monitor-status="true">
          {monitor.message}
        </span>
      </div>
      <p className="muted">最新30件・自分に関連する分析のみ。判定は各実行時点の記録です。</p>
      <AnalysisResults {...monitor.data} />
    </main>
  );
}
