import { actionUrl, afterProvision, dayRange, isHomeAction, type HomeAction } from './home-actions.js';
import { failureMessage } from './messages.js';
import { createWorkDefinition, readWorkDefinitionForm } from './work-definition-request.js';

/**
 * The home screen's browser half.
 *
 * Every button is one POST, and every success re-reads the page. The state of a piece
 * of work lives on the server — the draft, its confirmation, the permissions that were
 * presented and whether they were approved — so re-rendering from there is what keeps
 * the screen from claiming a step happened that did not. It also means a refusal is
 * shown exactly as the server phrased it rather than guessed at locally.
 *
 * Nothing polls. The page loads, and it changes when the person does something (DEV-13).
 */
export function start(root: Document = document, reload: () => void = () => root.location.reload()): void {
  const create = root.querySelector<HTMLFormElement>('[data-form="work-definition"]');
  create?.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveDraft(root, create, reload);
  });

  root.querySelectorAll<HTMLFormElement>('[data-form="revise"]').forEach((form) => {
    form.addEventListener('submit', (event: Event) => {
      event.preventDefault();
      void revise(form, reload);
    });
  });

  const suggestions = root.querySelector<HTMLFormElement>('[data-form="suggestions"]');
  suggestions?.addEventListener('submit', (event) => {
    event.preventDefault();
    void suggest(root, suggestions);
  });

  root.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    const action = button.getAttribute('data-action');
    if (!isHomeAction(action)) return;
    button.addEventListener('click', () => { void run(button, action, reload); });
  });
}

async function saveDraft(root: Document, form: HTMLFormElement, reload: () => void): Promise<void> {
  const created = await createWorkDefinition(readWorkDefinitionForm(form));
  if (created.ok) return reload();
  report(root.querySelector('[data-field="form-status"]'), failureMessage(created.status, created.body), 'error');
}

/**
 * One turn with the Automation Design AI. It rewrites the wording of a draft and can do
 * nothing else: the endpoint has no branch that writes `status`, so a rewrite never
 * confirms the work (RULE-08).
 */
async function revise(form: HTMLFormElement, reload: () => void): Promise<void> {
  const id = form.getAttribute('data-work-definition-id');
  const text = String(new FormData(form).get('text') ?? '').trim();
  if (!id || text === '') return;
  const response = await fetch(`/api/work-definitions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (response.ok) return reload();
  const body = await response.json().catch(() => ({})) as { error?: string };
  report(statusFieldFor(form), failureMessage(response.status, body), 'error');
}

async function run(button: HTMLButtonElement, action: HomeAction, reload: () => void): Promise<void> {
  const id = button.getAttribute(action === 'confirm' || action === 'submit'
    ? 'data-work-definition-id'
    : 'data-agent-definition-id');
  if (!id) return;
  button.disabled = true;
  const response = await fetch(actionUrl(action, id), { method: 'POST', credentials: 'same-origin' });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    button.disabled = false;
    report(statusFieldFor(button), failureMessage(response.status, body), 'error');
    return;
  }
  // Provisioning is the one answer that can send the browser elsewhere: to the consent
  // screen the Provisioner named, or to the agent that now exists.
  if (action !== 'provision') return reload();
  const outcome = afterProvision(body);
  if (outcome.kind === 'navigate' && outcome.url) {
    button.ownerDocument.location.assign(outcome.url);
    return;
  }
  reload();
}

async function suggest(root: Document, form: HTMLFormElement): Promise<void> {
  const values = new FormData(form);
  const status = root.querySelector('[data-field="suggest-status"]');
  const list = root.querySelector('[data-field="suggestions"]');
  const response = await fetch('/api/automation/suggestions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dayRange(String(values.get('from') ?? ''), String(values.get('to') ?? ''))),
  });
  const body = await response.json().catch(() => ({})) as {
    suggestions?: Array<{ purpose: string; description: string; operations: string[]; user_confirmations: string[]; safety_notes: string[] }>;
    error?: string;
  };
  if (!response.ok) return report(status, failureMessage(response.status, body), 'error');
  const suggestions = body.suggestions ?? [];
  if (list) {
    list.textContent = '';
    for (const suggestion of suggestions) list.appendChild(suggestionItem(root, suggestion));
  }
  report(status, suggestions.length === 0
    ? '候補は見つかりませんでした。作業の内容を自分で書いてください。'
    : `${suggestions.length} 件の候補が挙がりました。使うものを選んでください。`, 'listed');
}

/**
 * A candidate fills the form and nothing more. It is a starting point for what the
 * person writes, never a draft that got saved on their behalf.
 */
function suggestionItem(root: Document, suggestion: {
  purpose: string; description: string;
  operations: string[]; user_confirmations: string[]; safety_notes: string[];
}): HTMLElement {
  const item = root.createElement('li');
  const title = root.createElement('p');
  title.textContent = `${suggestion.purpose}：${suggestion.description}`;
  const use = root.createElement('button');
  use.setAttribute('type', 'button');
  use.setAttribute('data-action', 'use-suggestion');
  use.textContent = 'この候補を書き写す';
  use.addEventListener('click', () => {
    fill(root, 'purpose', suggestion.purpose);
    fill(root, 'description', suggestion.description);
    fill(root, 'operations', suggestion.operations.join('\n'));
    fill(root, 'user_confirmations', suggestion.user_confirmations.join('\n'));
    fill(root, 'safety_notes', suggestion.safety_notes.join('\n'));
  });
  item.appendChild(title);
  item.appendChild(use);
  return item;
}

function fill(root: Document, name: string, value: string): void {
  const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-form="work-definition"] [name="${name}"]`);
  if (field) field.value = value;
}

/**
 * The message belongs to the card the person pressed in, if there is one. The card is
 * matched by its own element rather than by the attribute alone: the rewrite form
 * carries the same id, and `closest` would stop at the form, whose subtree holds no
 * place to put the message.
 */
function statusFieldFor(element: Element): Element | null {
  return element.closest('article[data-work-definition-id]')?.querySelector('[data-field="action-status"]') ?? null;
}

function report(field: Element | null, message: string, state: 'error' | 'listed'): void {
  if (!field) return;
  field.setAttribute('data-status', state);
  field.textContent = message;
}

if (typeof document !== 'undefined') start();
