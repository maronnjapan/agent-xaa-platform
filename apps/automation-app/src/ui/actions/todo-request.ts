/**
 * The one shape a ToDo is sent in, and the one place a form is read into it.
 *
 * Two screens carry the same form — the home screen and the standalone page — and the
 * edit box on a draft carries it a third time. All of them post the same JSON to the
 * same API the person's later actions use. Keeping the conversion here is what stops a
 * second, subtly different body from appearing when one of the three is edited.
 */

export interface TodoBody {
  title: string;
  description: string;
  context: string;
  done_criteria: string[];
  steps: string[];
  notes: string[];
  priority: string;
  due_on: string | null;
  requested_lifetime_minutes: number;
}

/** One item per line: a person describing their own work writes a list, not JSON. */
export function toTodoBody(read: (name: string) => string): TodoBody {
  const lines = (name: string): string[] =>
    read(name).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const dueOn = read('due_on').trim();
  return {
    title: read('title'),
    description: read('description'),
    context: read('context'),
    done_criteria: lines('done_criteria'),
    steps: lines('steps'),
    notes: lines('notes'),
    priority: read('priority') || 'normal',
    due_on: dueOn === '' ? null : dueOn,
    requested_lifetime_minutes: Number(read('requested_lifetime_minutes')),
  };
}

export function readTodoForm(form: HTMLFormElement): TodoBody {
  const values = new FormData(form);
  return toTodoBody((name) => String(values.get(name) ?? ''));
}

export interface TodoResponse {
  ok: boolean;
  status: number;
  body: { work_definition_id?: string; error?: string };
}

async function send(url: string, method: 'POST' | 'PATCH', body: TodoBody): Promise<TodoResponse> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => ({})) as { work_definition_id?: string; error?: string },
  };
}

/**
 * The bounds on the lifetime, and every other rule, are the server's. The browser
 * reports what it was told; it never decides that a ToDo was acceptable.
 */
export function createTodo(body: TodoBody): Promise<TodoResponse> {
  return send('/api/todos', 'POST', body);
}

export function updateTodo(id: string, body: TodoBody): Promise<TodoResponse> {
  return send(`/api/todos/${encodeURIComponent(id)}`, 'PATCH', body);
}
