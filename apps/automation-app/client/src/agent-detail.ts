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
  const form = root.querySelector<HTMLFormElement>('[data-form="instruction"]');
  form?.addEventListener('submit', (event: Event) => {
    event.preventDefault();
    void instruct(root, form);
  });

  const stop = root.querySelector<HTMLButtonElement>('button[data-action="stop"]');
  stop?.addEventListener('click', () => { void halt(root, stop, reload); });
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
