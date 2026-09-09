import { startMonitor } from './monitor.js';
import { failureMessage } from './messages.js';

/**
 * The agent screen's browser half: an instruction, and a stop.
 *
 * Both are one POST behind the ownership check, and neither is retried on its own. The
 * stop button reports what the Lifecycle Manager said rather than assuming: telling a
 * person their agent stopped when it did not is the worst thing this particular button
 * could do.
 */
export function start(root: Document = document, reload: () => void = () => root.location.reload()): void {
  const agentId = root.querySelector('[data-agent-id]')?.getAttribute('data-agent-id');
  if (agentId) startMonitor(root, `/api/agents/${encodeURIComponent(agentId)}/status-view`, '[data-section="status"]');
  const fault = root.querySelector<HTMLButtonElement>('[data-action="inject-fault"]');
  const consent = root.querySelector<HTMLInputElement>('[data-fault-consent]');
  consent?.addEventListener('change', () => { if (fault) fault.disabled = !consent.checked; });
  fault?.addEventListener('click', () => { void injectFault(root, fault); });
  const form = root.querySelector<HTMLFormElement>('[data-form="instruction"]');
  form?.addEventListener('submit', (event: Event) => {
    event.preventDefault();
    void instruct(root, form).catch(() => report(root, '通信に失敗しました。指示の反映状況を確認してください。', 'error'));
  });

  const stop = root.querySelector<HTMLButtonElement>('button[data-action="stop"]');
  stop?.addEventListener('click', () => { void halt(root, stop, reload).catch(() => { stop.disabled = false; report(root, '通信に失敗しました。実行状況を更新して確認してください。', 'error'); }); });
}

async function instruct(root: Document, form: HTMLFormElement): Promise<void> {
  const agentId = form.getAttribute('data-agent-id');
  const field = form.querySelector<HTMLTextAreaElement>('[name="text"]');
  const text = (field?.value ?? '').trim();
  if (!agentId || text === '') return;
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/instructions`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) return report(root, failureMessage(response.status, body), 'error');
  if (field) field.value = '';
  report(root, '指示を追加しました。Agent が次の区切りで読み取ります。', 'done');
}

async function halt(root: Document, button: HTMLButtonElement, reload: () => void): Promise<void> {
  const agentId = button.getAttribute('data-agent-id');
  if (!agentId) return;
  button.disabled = true;
  const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/stop`, {
    method: 'POST', credentials: 'same-origin',
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) {
    button.disabled = false;
    return report(root, failureMessage(response.status, body), 'error');
  }
  reload();
}

function report(root: Document, message: string, state: 'error' | 'done'): void {
  const field = root.querySelector('[data-field="control-status"]');
  if (!field) return;
  field.setAttribute('data-status', state);
  field.textContent = message;
}

if (typeof document !== 'undefined') start();

async function injectFault(root: Document, button: HTMLButtonElement): Promise<void> {
  const agentId = button.getAttribute('data-agent-id');
  const consent = root.querySelector<HTMLInputElement>('[data-fault-consent]');
  const status = root.querySelector('[data-fault-status]');
  if (!agentId || !consent?.checked) return;
  button.disabled = true;
  consent.disabled = true;
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/faults`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'runtime_crash' }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; instruction_id?: string };
    if (!response.ok) {
      const messages: Record<string, string> = {
        agent_not_active: '現在実行中のTaskがありません。実行状況を更新してください。',
        fault_already_pending: 'このTaskには試験要求が登録済みです。異常系試験の状態を確認してください。',
        fault_injection_disabled: 'この環境では異常系試験が無効です。',
      };
      if (status) status.textContent = messages[body.error ?? ''] ?? failureMessage(response.status, body);
      consent.disabled = false;
      button.disabled = !consent.checked;
      return;
    }
    if (status) status.textContent = `試験要求を受け付けました（${body.instruction_id ?? '受付済み'}）。次の処理開始時に適用されます。「異常系試験の状態」で実行の失敗を確認してください。Agentの管理状態は ACTIVE のままです。`;
    root.querySelector<HTMLButtonElement>('[data-action="monitor-refresh"]')?.click();
  } catch {
    if (status) status.textContent = '試験要求を確認できませんでした。実行終了、要求済み、または通信エラーの可能性があります。状態を更新してください。';
    consent.disabled = false;
    button.disabled = false;
  }
}
