import { useState } from 'react';
import { createTodo, type TodoBody } from '../actions/todo-request.js';
import { failureMessage } from '../actions/messages.js';
import { TodoForm } from '../components/todo-form.js';
import type { Element } from '../element.js';

/**
 * The form on a page of its own, which is where the blocked guidance sends a person
 * whose agent was refused: RULE-13 fixes an agent's permissions for its life, so the
 * only way forward is a ToDo written from scratch.
 *
 * What the person does with the ToDo afterwards — confirm it, look at the permissions
 * it needs, approve them — happens on the home screen, which lists every ToDo they
 * have. So this says what the server said about the save, and stops there.
 *
 * The bounds on the lifetime, and every other rule, are the server's. This reports what
 * it was told; it never decides that a ToDo was acceptable.
 */
export function TodoNewPage(props: { defaultMinutes: number }): Element {
  const [status, setStatus] = useState<{ text: string; state: string }>({ text: '', state: '' });

  const save = (body: TodoBody): void => {
    void (async () => {
      const created = await createTodo(body);
      setStatus(created.ok
        ? { text: `ToDo を登録しました（${created.body.work_definition_id ?? ''}）。一覧は「ToDo」にあります。`, state: 'created' }
        : { text: failureMessage(created.status, created.body), state: 'error' });
    })();
  };

  return (
    <main className="todo-new" data-page="todo-new">
      <h1>新しい ToDo を書く</h1>
      <p className="lead">AI に任せたいことを1件書きます。登録した ToDo は<a href="/">ToDo</a>の一覧に並びます。</p>
      <TodoForm defaultMinutes={props.defaultMinutes} onSubmit={save} />
      <p data-field="form-status" data-status={status.state}>{status.text}</p>
    </main>
  );
}
