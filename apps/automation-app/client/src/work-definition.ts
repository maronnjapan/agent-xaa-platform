/**
 * The new-work-definition form's browser half.
 *
 * The form posts JSON to the same API a person's later actions use, so there is no
 * second, form-encoded way into the store to keep in step. It reports what the server
 * said and nothing more: the lifetime bounds, for instance, are enforced by the server
 * and echoed here, never decided here.
 */
export function start(root: Document = document): void {
  const form = root.querySelector<HTMLFormElement>('[data-form="work-definition"]');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(form);
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  const status = form.ownerDocument.querySelector('[data-field="form-status"]');
  const values = new FormData(form);
  const text = (name: string): string => String(values.get(name) ?? '');
  // One item per line: a person describing their own work writes a list, not JSON.
  const lines = (name: string): string[] =>
    text(name).split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const response = await fetch('/api/work-definitions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      purpose: text('purpose'),
      description: text('description'),
      operations: lines('operations'),
      user_confirmations: lines('user_confirmations'),
      safety_notes: lines('safety_notes'),
      requested_lifetime_hours: Number(text('requested_lifetime_hours')),
    }),
  });
  const body = await response.json().catch(() => ({})) as { work_definition_id?: string; error?: string };
  if (!status) return;
  status.setAttribute('data-status', response.ok ? 'created' : 'error');
  status.textContent = response.ok
    ? `作業を下書きとして保存しました（${body.work_definition_id ?? ''}）`
    : `保存できませんでした（${body.error ?? String(response.status)}）`;
}

if (typeof document !== 'undefined') start();
