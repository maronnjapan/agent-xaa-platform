import { createWorkDefinition, readWorkDefinitionForm } from './work-definition-request.js';

/**
 * The standalone new-work page's browser half.
 *
 * It saves the draft and says what the server said, and stops there: what happens to a
 * draft afterwards — the rewrite, the confirmation, the permissions and their approval —
 * is the home screen's, which lists every draft the person has.
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
  const created = await createWorkDefinition(readWorkDefinitionForm(form));
  if (!status) return;
  status.setAttribute('data-status', created.ok ? 'created' : 'error');
  status.textContent = created.ok
    ? `作業を下書きとして保存しました（${created.body.work_definition_id ?? ''}）`
    : `保存できませんでした（${created.body.error ?? ''}）`;
}

if (typeof document !== 'undefined') start();
