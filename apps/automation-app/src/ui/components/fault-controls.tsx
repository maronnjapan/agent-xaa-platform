import { useState } from 'react';
import { FAULT_KINDS, type FaultKind } from '@xaa/contracts/fault-injection';
import { agentFaultsPath } from '../../agents/page-link.js';
import { failureMessage } from '../actions/messages.js';
import { FAULT_KIND_TEXT, TRIAL_STEP_LABELS } from './trial-tracker.js';
import type { Element } from '../element.js';

export const FAULT_HEADING = '異常系を試す';
export const FAULT_LEAD = '動いている Agent をわざと失敗させ、状況確認・実行ログ・タイムラインにどう現れるかを確かめます。次の手の頭で適用され、実行が先に終わっていれば適用されません。';

/**
 * The failure exercise, as three choices and one button.
 *
 * Each choice says what it does and what to look for afterwards, before the button
 * is pressed, because the exercise is only useful to someone who knows what a
 * confirmed one of it looks like. The words are the same ones the tracker beside the
 * status panel uses, so the promise here and the confirmation there cannot differ.
 *
 * What is being failed is the execution, never the agent's Lifecycle state, and the
 * panel says so next to the button: a person who reads 「失敗」 on the status panel
 * afterwards and 「ACTIVE」 beside it needs to have been told why in advance.
 */
export function FaultControls(props: { agentId: string; onAccepted(): Promise<void> }): Element {
  const [kind, setKind] = useState<FaultKind>('runtime_crash');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [message, setMessage] = useState('');
  const chosen = FAULT_KIND_TEXT[kind];
  const inject = async () => {
    if (!consent || busy || accepted) return;
    setBusy(true);
    try {
      const response = await fetch(agentFaultsPath(props.agentId), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }), signal: AbortSignal.timeout(10_000),
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
      setMessage(`試験要求を受け付けました（${body.instruction_id ?? '受付済み'}）。「異常系試験の状態」で「${chosen.confirmed}」になるのを待ってください。Agentの管理状態は ACTIVE のままです。`);
      await props.onAccepted();
    } catch {
      setMessage('試験要求を確認できませんでした。実行状況を更新して、登録の有無を確認してください。');
    } finally { setBusy(false); }
  };
  return (
    <section className="card fault-panel" data-section="fault-controls">
      <span className="eyebrow">FAILURE TEST</span><h2>{FAULT_HEADING}</h2>
      <p>{FAULT_LEAD}</p>
      <fieldset className="fault-kinds" disabled={busy || accepted}>
        <legend>起こす失敗</legend>
        {FAULT_KINDS.map((candidate) => (
          <label key={candidate} className="fault-kind" data-fault-kind={candidate} data-chosen={candidate === kind ? 'true' : 'false'}>
            <input type="radio" name="fault-kind" value={candidate} checked={candidate === kind} onChange={() => setKind(candidate)} />
            <span className="fault-kind-body">
              <strong>{FAULT_KIND_TEXT[candidate].label}</strong>
              <span>{FAULT_KIND_TEXT[candidate].effect}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ol className="test-flow" aria-label="異常系試験の流れ" data-fault-flow={kind}>
        <li><b>01</b><strong>{TRIAL_STEP_LABELS.requested}</strong><span>いま実行中の Task に結び付けます</span></li>
        <li><b>02</b><strong>{TRIAL_STEP_LABELS.received}</strong><span>次の手の頭で読み取り、適用します</span></li>
        <li><b>03</b><strong>{chosen.confirmed}</strong><span>{chosen.watch}</span></li>
      </ol>
      <p className="notice">実行の失敗とAgentの管理状態は別です。試験後も管理状態は ACTIVE のままです。</p>
      <label><input type="checkbox" data-fault-consent="true" checked={consent} disabled={busy || accepted}
        onChange={(event) => setConsent(event.target.checked)} /> このAgentの実行を失敗させる（{chosen.label}）</label>
      <button type="button" className="danger-button" data-action="inject-fault" data-fault-kind={kind} disabled={!consent || busy || accepted} onClick={() => void inject()}>この失敗を起こす</button>
      <p data-fault-status="true" role="status">{message}</p>
      <p className="muted">Agentの停止・資格情報の失効を試す場合は「この Agent を止める」を使用してください。</p>
    </section>
  );
}
