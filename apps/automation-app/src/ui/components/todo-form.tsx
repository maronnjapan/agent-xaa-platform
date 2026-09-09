import type { RefObject } from 'react';
import { readTodoForm, type TodoBody } from '../actions/todo-request.js';
import { PRIORITY_LABELS } from './todo-labels.js';
import { LifetimeInput } from './lifetime-input.js';
import type { Element } from '../element.js';

/**
 * The blank ToDo, which is where every agent starts.
 *
 * The form asks only for what the person can answer: what they want done, what the
 * agent should know while doing it, how they will tell it is done, and for how long the
 * agent may run. It offers no way to name a permission — what the work needs is
 * inferred elsewhere and shown back to them for approval (RULE-07), and a field here
 * would invite them to guess at it first.
 *
 * It is a component rather than part of a page because three places open on it: the
 * home screen, the standalone page the blocked guidance points at, and the edit box on
 * a draft. One form means one set of field names, and one reading of them into the body
 * that is posted.
 *
 * The fields are uncontrolled. What the person is typing is theirs until they submit,
 * and holding every keystroke in React state would put the draft somewhere the server
 * has not seen and the person cannot see either. `initial` seeds the boxes when a draft
 * is being edited; it is a default, not state.
 */
export function TodoForm(props: {
  defaultMinutes: number;
  formRef?: RefObject<HTMLFormElement | null>;
  initial?: Partial<TodoBody>;
  submitLabel?: string;
  onSubmit?: (body: TodoBody) => void;
}): Element {
  const initial = props.initial ?? {};
  const lines = (values: readonly string[] | undefined): string => (values ?? []).join('\n');
  return (
    <form
      data-form="todo"
      ref={props.formRef}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit?.(readTodoForm(event.currentTarget));
      }}
    >
      <label>
        タイトル
        <input type="text" name="title" required defaultValue={initial.title ?? ''} />
      </label>
      <label>
        説明（何をしてほしいか）
        <textarea name="description" rows={3} defaultValue={initial.description ?? ''} />
      </label>
      <label>
        実行時のコンテキスト（背景、前提、関係する資料の場所など。AI が作業中に持っていてほしいこと）
        <textarea name="context" rows={4} defaultValue={initial.context ?? ''} />
      </label>
      <label>
        完了条件（1行に1つ。何ができたら終わりか）
        <textarea name="done_criteria" rows={3} defaultValue={lines(initial.done_criteria)} />
      </label>
      <label>
        手順（1行に1つ。任せてよければ空でよい）
        <textarea name="steps" rows={3} defaultValue={lines(initial.steps)} />
      </label>
      <label>
        注意点・やってはいけないこと（1行に1つ）
        <textarea name="notes" rows={3} defaultValue={lines(initial.notes)} />
      </label>
      <div className="todo-form-row">
        <label>
          優先度
          <select name="priority" defaultValue={initial.priority ?? 'normal'}>
            {(Object.keys(PRIORITY_LABELS) as Array<keyof typeof PRIORITY_LABELS>).map((value) => (
              <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>
            ))}
          </select>
        </label>
        <label>
          期限
          <input type="date" name="due_on" defaultValue={initial.due_on ?? ''} />
        </label>
        <LifetimeInput defaultMinutes={initial.requested_lifetime_minutes ?? props.defaultMinutes} />
      </div>
      <button type="submit" data-action="save-todo">{props.submitLabel ?? 'ToDo を登録する'}</button>
    </form>
  );
}
