import { useState } from 'react';
import { agentFaultsPath } from '../../agents/page-link.js';
import { failureMessage } from '../actions/messages.js';
import type { Element } from '../element.js';

export function FaultControls(props: { agentId: string; onAccepted(): Promise<void> }): Element {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const inject = async () => {
    if (!consent || busy || accepted) return;
    setBusy(true);
    try {
      const response = await fetch(agentFaultsPath(props.agentId), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'runtime_crash' }), signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; instruction_id?: string };
      if (!response.ok) {
        const messages: Record<string, string> = {
          agent_not_active: '現在実行中のTaskがありません。実行状況を更新してください。',
          fault_already_pending: 'このTaskには試験要求が登録済みです。異常系試験の状態を確認してください。',
          fault_injection_disabled: 'この環境では異常系試験が無効です。',
        };
        setMessage(messages[body.error ?? ''] ?? failureMessage(response.status, body));
        return;
      }
      setAccepted(true);
      setMessage(`試験要求を受け付けました（${body.instruction_id ?? '受付済み'}）。「異常系試験の状態」で実行の失敗を確認してください。Agentの管理状態は ACTIVE のままです。`);
      await props.onAccepted();
    } catch {
      setMessage('試験要求を確認できませんでした。実行状況を更新して、登録の有無を確認してください。');
    } finally { setBusy(false); }
  };
  return (
    <section className="card fault-panel">
      <span className="eyebrow">FAILURE TEST</span><h2>異常系を試す</h2>
      <p>実行中のAgentに例外を発生させます。次の推論ステップで実行が失敗し、失敗ログとタスク結果が記録されます。実行が終了済みの場合は適用されません。</p>
      <ol className="test-flow" aria-label="異常系試験の流れ">
        <li><b>01</b><strong>要求を登録</strong><span>現在のTaskを指定</span></li>
        <li><b>02</b><strong>Runtimeで例外</strong><span>次の推論ステップで適用</span></li>
        <li><b>03</b><strong>失敗を確認</strong><span>実行ログとアクティビティ</span></li>
      </ol>
      <p className="notice">実行の失敗とAgentの管理状態は別です。試験後も管理状態は ACTIVE のままです。</p>
      <label><input type="checkbox" data-fault-consent="true" checked={consent} disabled={busy || accepted}
        onChange={(event) => setConsent(event.target.checked)} /> このAgentの実行を失敗させる</label>
      <button type="button" className="danger-button" data-action="inject-fault" disabled={!consent || busy || accepted} onClick={() => void inject()}>実行失敗を発生させる</button>
      <p data-fault-status="true" role="status">{message}</p>
      <p className="muted">Agentの停止・資格情報の失効を試す場合は「この Agent を止める」を使用してください。</p>
    </section>
  );
}
