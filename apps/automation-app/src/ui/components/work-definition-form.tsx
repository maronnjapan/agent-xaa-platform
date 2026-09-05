import { LifetimeInput } from './lifetime-input.js';
import type { Element } from '../element.js';


/**
 * The blank description of work, which is where every agent starts.
 *
 * The form asks only for what the person can answer: what they want done, how, and
 * for how long. It offers no way to name a permission — what the work needs is
 * inferred elsewhere and shown back to them for approval (RULE-07), and a field here
 * would invite them to guess at it first.
 *
 * It is a component rather than part of a page because two screens open on it: the
 * home screen, where the work is described and then carried through to an agent, and
 * the standalone page the blocked guidance points at. One form means one set of field
 * names for the browser half to read.
 */
export function WorkDefinitionForm(props: { defaultMinutes: number }): Element {
  return (
    <form data-form="work-definition">
      <label>
        目的
        <input type="text" name="purpose" required />
      </label>
      <label>
        説明
        <textarea name="description" rows={3} />
      </label>
      <label>
        作業の手順（1行に1つ）
        <textarea name="operations" rows={4} />
      </label>
      <label>
        確認したいこと（1行に1つ）
        <textarea name="user_confirmations" rows={3} />
      </label>
      <label>
        注意点（1行に1つ）
        <textarea name="safety_notes" rows={3} />
      </label>
      <LifetimeInput defaultMinutes={props.defaultMinutes} />
      <button type="submit" data-action="create-work-definition">下書きを保存する</button>
    </form>
  );
}
