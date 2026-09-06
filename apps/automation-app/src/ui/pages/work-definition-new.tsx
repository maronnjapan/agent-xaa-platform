import { useState } from 'react';
import { createWorkDefinition, type WorkDefinitionBody } from '../actions/work-definition-request.js';
import { WorkDefinitionForm } from '../components/work-definition-form.js';
import type { Element } from '../element.js';

/**
 * The form on a page of its own, which is where the blocked guidance sends a person
 * whose agent was refused: RULE-13 fixes an agent's permissions for its life, so the
 * only way forward is a work definition written from scratch.
 *
 * What the person does with the draft afterwards — confirm it, look at the permissions
 * it needs, approve them — happens on the home screen, which lists every draft they
 * have. So this says what the server said about the save, and stops there.
 *
 * The bounds on the lifetime, and every other rule, are the server's. This reports what
 * it was told; it never decides that a draft was acceptable.
 */
export function WorkDefinitionNewPage(props: { defaultMinutes: number }): Element {
  const [status, setStatus] = useState<{ text: string; state: string }>({ text: '', state: '' });

  const save = (body: WorkDefinitionBody): void => {
    void (async () => {
      const created = await createWorkDefinition(body);
      setStatus(created.ok
        ? { text: `作業を下書きとして保存しました（${created.body.work_definition_id ?? ''}）`, state: 'created' }
        : { text: `保存できませんでした（${created.body.error ?? ''}）`, state: 'error' });
    })();
  };

  return (
    <main className="work-definition-new" data-page="work-definition-new">
      <h1>新しい作業を定義する</h1>
      <WorkDefinitionForm defaultMinutes={props.defaultMinutes} onSubmit={save} />
      <p data-field="form-status" data-status={status.state}>{status.text}</p>
    </main>
  );
}
