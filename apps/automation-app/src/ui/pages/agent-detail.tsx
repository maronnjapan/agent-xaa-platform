import type { FaultTrial } from '../../agents/faults.js';
import type { AgentStatusResponse } from '../../agents/status.js';
import { AgentControls } from '../components/agent-controls.js';
import { StatusPanel } from '../components/status-panel.js';
import { TimelineLink } from '../components/timeline-link.js';
import { BlockedGuidance } from '../components/blocked-guidance.js';
import type { Element } from '../element.js';

/**
 * Status above, the two operations under it, timeline link below, and the guidance only
 * when something was refused.
 *
 * The two sections carry distinct `data-section` attributes and share no data: the
 * status panel never reads timeline events, and the timeline link never reads the
 * checkpoint. Keeping them apart in the DOM is how the distinction survives later edits.
 */
export function AgentDetailPage(props: {
  agentId: string;
  status: AgentStatusResponse;
  faultInjectionEnabled?: boolean;
  faultTrials?: FaultTrial[];
}): Element {
  const blocked = props.status.tool_invocations.some((invocation) => invocation.outcome === 'blocked');
  return (
    <main class="agent-detail" data-agent-id={props.agentId}>
      <header class="page-heading">
        <div>
          <span class="eyebrow">AGENT EXECUTION</span>
          <h1>エージェントの実行状況</h1>
          <p class="muted agent-identifier">{props.agentId}</p>
        </div>
        <button type="button" data-action="monitor-refresh">
          更新
        </button>
      </header>
      <div class="monitor-toolbar">
        <label>
          <input type="checkbox" data-monitor-auto="true" checked /> 5秒ごとに更新
        </label>
        <span data-monitor-status="true" role="status" />
      </div>
      <StatusPanel status={props.status} faultTrials={props.faultTrials ?? []} />
      <AgentControls agentId={props.agentId} />
      {blocked ? <BlockedGuidance /> : null}
      {props.faultInjectionEnabled ? (
        <section class="card fault-panel">
          <span class="eyebrow">FAILURE TEST</span>
          <h2>異常系を試す</h2>
          <p>
            実行中のAgentに例外を発生させます。次の処理開始時に実行が失敗し、失敗ログとタスク結果が記録されます。実行が終了済みの場合は適用されません。
          </p>
          <ol class="test-flow" aria-label="異常系試験の流れ">
            <li><b>01</b><strong>要求を登録</strong><span>現在のTaskを指定</span></li>
            <li><b>02</b><strong>Runtimeで例外</strong><span>次の推論ステップで適用</span></li>
            <li><b>03</b><strong>失敗を確認</strong><span>実行ログとアクティビティ</span></li>
          </ol>
          <p class="notice">実行の失敗とAgentの管理状態は別です。試験後も管理状態は ACTIVE のままです。</p>
          <label>
            <input type="checkbox" data-fault-consent="true" /> このAgentの実行を失敗させる
          </label>
          <button
            type="button"
            class="danger-button"
            data-action="inject-fault"
            data-agent-id={props.agentId}
            disabled
          >
            実行失敗を発生させる
          </button>
          <p data-fault-status="true" role="status" />
          <p class="muted">Agentの停止・資格情報の失効を試す場合は「停止」を使用してください。</p>
        </section>
      ) : null}
      <TimelineLink agentId={props.agentId} />
    </main>
  );
}
