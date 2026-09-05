import { WorkDefinitionForm } from '../components/work-definition-form.js';
import type { Element } from '../element.js';


/**
 * The form on a page of its own, which is where the blocked guidance sends a person
 * whose agent was refused: RULE-13 fixes an agent's permissions for its life, so the
 * only way forward is a work definition written from scratch.
 *
 * What the person does with the draft afterwards — confirm it, look at the permissions
 * it needs, approve them — happens on the home screen, which lists every draft they
 * have.
 */
export function WorkDefinitionNewPage(props: { defaultMinutes: number }): Element {
  return (
    <main class="work-definition-new" data-page="work-definition-new">
      <h1>新しい作業を定義する</h1>
      <WorkDefinitionForm defaultMinutes={props.defaultMinutes} />
      <p data-field="form-status" data-status="" />
    </main>
  );
}
