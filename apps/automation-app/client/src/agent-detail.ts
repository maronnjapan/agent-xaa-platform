import { failureMessage } from './messages.js';

/**
 * What the button says once the Lifecycle Manager has taken the stop.
 *
 * A 200 here means the request was accepted, and the destruction — cancelling the Job
 * Execution, revoking the credentials — runs on the Lifecycle Manager's side after the
 * answer. The sentence says both halves, because a person who pressed an irreversible
 * button and read only 「止めました」 would still be wondering what is left running.
 */
export const STOP_ACCEPTED = '止めました。Lifecycle Manager が実行を終了し、資格情報を失効させます。';

/**
 * The agent screen's browser half: an instruction, and a stop.
 *
 * Both are one POST behind the ownership check, and neither is retried on its own. The
 * stop button reports what the Lifecycle Manager said rather than assuming: telling a
 * person their agent stopped when it did not is the worst thing this particular button
 * could do.
 */
export function start(root: Document = document): void {
  const form = root.querySelector<HTMLFormElement>('[data-form="instruction"]');
  form?.addEventListener('submit', (event: Event) => {
    event.preventDefault();
    void instruct(root, form);
  });

  const stop = root.querySelector<HTMLButtonElement>('button[data-action="stop"]');
  stop?.addEventListener('click', () => { void halt(root, stop); });
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

/**
 * The one operation on this screen that says it worked rather than re-reading the page.
 *
 * Every other button in this app answers a success by reloading, because the state it
 * changed lives on the server and re-rendering from there is what keeps the screen
 * honest. This one cannot: a stopped agent is destroyed, its registration goes, and the
 * ownership guard that every screen runs behind answers 404 for an agent that is no
 * longer there. Reloading would race the cleanup and land the person on a JSON refusal
 * for the agent they had just successfully stopped. So the answer is shown where the
 * refusals are shown, and the button stays disabled: there is nothing left to press.
 */
async function halt(root: Document, button: HTMLButtonElement): Promise<void> {
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
  report(root, STOP_ACCEPTED, 'done');
}

function report(root: Document, message: string, state: 'error' | 'done'): void {
  const field = root.querySelector('[data-field="control-status"]');
  if (!field) return;
  field.setAttribute('data-status', state);
  field.textContent = message;
}

if (typeof document !== 'undefined') start();
