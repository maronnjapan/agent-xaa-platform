import { useRef, useState } from 'react';
import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { WorkDefinition } from '../../work-definition/model.js';
import { agentPagePath } from '../../agents/page-link.js';
import { dayRange } from '../actions/home-actions.js';
import { failureMessage } from '../actions/messages.js';
import { reloadPage } from '../actions/navigate.js';
import { createTodo, type TodoBody } from '../actions/todo-request.js';
import { TodoForm } from '../components/todo-form.js';
import { TodoCard, type TodoAgentView } from '../components/todo-card.js';
import { isClosedStatus } from '../components/todo-labels.js';
import type { Element } from '../element.js';

export type { TodoAgentView };

export interface HomeTodoItem {
  definition: WorkDefinition;
  agentDefinition?: AgentDefinition | undefined;
  /** The agent carrying this ToDo, once one exists. */
  agent?: TodoAgentView | undefined;
}

export interface HomeAgent {
  agentId: string;
  purpose: string;
}

export const HOME_LEAD = 'AI に任せたい ToDo を書き、提示された権限を承認すると、Agent がその ToDo を実行します。';
export const NO_SUGGESTIONS = '候補は見つかりませんでした。ToDo を自分で書いてください。';
export const NO_TODOS = 'まだ ToDo がありません。上の欄に書いて登録してください。';

interface Suggestion {
  title: string;
  description: string;
  context: string;
  done_criteria: string[];
  steps: string[];
  notes: string[];
}

/**
 * The screen a person lands on after logging in, and the one place the whole flow
 * happens: write a ToDo, confirm it, look at the permissions it turned out to need,
 * approve them, let the agent be created, watch it carry the ToDo out, and close it.
 *
 * Every step is a request the person makes. Nothing here advances on a timer, and
 * nothing is decided by the model that helps write the ToDo — the irreversible steps,
 * confirming the wording, approving the permissions and closing the ToDo, are separate
 * buttons with the permission set printed between them (RULE-08).
 *
 * The list is in two parts: the ToDos still open, in the order they need attention,
 * and the ones already closed, folded under them. The sections are ordered the way the
 * work moves, and each carries its own `data-section` so one can be found without
 * knowing the others.
 */
export function HomePage(props: {
  defaultMinutes: number;
  items: readonly HomeTodoItem[];
  agents: readonly HomeAgent[];
  defaultFrom: string;
  defaultTo: string;
  today: string;
}): Element {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [formStatus, setFormStatus] = useState('');
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [suggestStatus, setSuggestStatus] = useState<{ text: string; state: string }>({ text: '', state: '' });
  const openItems = props.items.filter((item) => !isClosedStatus(item.definition.status));
  const closedItems = props.items.filter((item) => isClosedStatus(item.definition.status));

  const save = (body: TodoBody): void => {
    void (async () => {
      const created = await createTodo(body);
      if (created.ok) return reloadPage();
      setFormStatus(failureMessage(created.status, created.body));
    })();
  };

  const suggest = (from: string, to: string): void => {
    void (async () => {
      const response = await fetch('/api/automation/suggestions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dayRange(from, to)),
      });
      const body = await response.json().catch(() => ({})) as { suggestions?: Suggestion[]; error?: string };
      if (!response.ok) {
        setSuggestStatus({ text: failureMessage(response.status, body), state: 'error' });
        return;
      }
      const found = body.suggestions ?? [];
      setSuggestions(found);
      setSuggestStatus({
        text: found.length === 0 ? NO_SUGGESTIONS : `${found.length} 件の候補が挙がりました。使うものを選んでください。`,
        state: 'listed',
      });
    })();
  };

  /**
   * A candidate fills the form and nothing more. It is a starting point for what the
   * person writes, never a ToDo that got registered on their behalf — which is why it
   * is written into the fields rather than posted.
   */
  const copyInto = (suggestion: Suggestion): void => {
    const form = formRef.current;
    if (!form) return;
    const fill = (name: string, value: string): void => {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = value;
    };
    fill('title', suggestion.title);
    fill('description', suggestion.description);
    fill('context', suggestion.context);
    fill('done_criteria', suggestion.done_criteria.join('\n'));
    fill('steps', suggestion.steps.join('\n'));
    fill('notes', suggestion.notes.join('\n'));
  };

  const card = (item: HomeTodoItem): Element => (
    <TodoCard
      key={item.definition.work_definition_id}
      definition={item.definition}
      agentDefinition={item.agentDefinition}
      agent={item.agent}
      defaultMinutes={props.defaultMinutes}
      today={props.today}
    />
  );

  return (
    <main className="home" data-page="home">
      <h1>ToDo</h1>
      <p className="lead">{HOME_LEAD}</p>

      <section className="card" data-section="suggest">
        <h2>ToDo の候補を探す</h2>
        <p>記録に残っている作業から、AI に任せられそうな ToDo の候補を挙げます。書く内容が決まっているなら飛ばせます。</p>
        <form
          data-form="suggestions"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            suggest(String(values.get('from') ?? ''), String(values.get('to') ?? ''));
          }}
        >
          <label>
            はじめの日
            <input type="date" name="from" defaultValue={props.defaultFrom} />
          </label>
          <label>
            おわりの日
            <input type="date" name="to" defaultValue={props.defaultTo} />
          </label>
          <button type="submit" data-action="suggest">候補を挙げてもらう</button>
        </form>
        <ul data-field="suggestions">
          {suggestions.map((suggestion, index) => (
            <li key={`${index}:${suggestion.title}`}>
              <p>{`${suggestion.title}：${suggestion.description}`}</p>
              <button type="button" data-action="use-suggestion" onClick={() => copyInto(suggestion)}>この候補を書き写す</button>
            </li>
          ))}
        </ul>
        <p data-field="suggest-status" data-status={suggestStatus.state}>{suggestStatus.text}</p>
      </section>

      <section className="card" data-section="new-todo">
        <h2>1. ToDo を書く</h2>
        <p>権限は書きません。書いた内容から決まり、あとで提示されます。</p>
        <TodoForm defaultMinutes={props.defaultMinutes} formRef={formRef} onSubmit={save} />
        <p data-field="form-status" data-status={formStatus === '' ? '' : 'error'}>{formStatus}</p>
      </section>

      <section className="card" data-section="todos">
        <h2>2. ToDo 一覧</h2>
        <p>確定し、提示された権限を承認すると Agent が作られ、ToDo を実行します。終わったら「完了にする」で閉じます。</p>
        {openItems.length === 0
          ? <p data-field="empty">{NO_TODOS}</p>
          : <div data-field="open-todos">{openItems.map(card)}</div>}
        {closedItems.length > 0
          ? (
            <details className="todo-archive" data-section="closed-todos">
              <summary>{`終わった ToDo（${String(closedItems.length)} 件）`}</summary>
              {closedItems.map(card)}
            </details>
          )
          : null}
      </section>

      <section className="card" data-section="running-agents">
        <h2>3. 動き出した Agent</h2>
        {props.agents.length === 0
          ? <p data-field="no-agents">まだ Agent はいません。権限を承認すると作られます。</p>
          : (
            <ul data-field="agent-list">
              {props.agents.map((agent) => (
                <li key={agent.agentId} data-agent-id={agent.agentId}>
                  <a href={agentPagePath(agent.agentId)}>{agent.purpose === '' ? agent.agentId : agent.purpose}</a>
                </li>
              ))}
            </ul>
          )}
        <p><a href="/activity">実行の様子をアクティビティで見る</a></p>
      </section>
    </main>
  );
}
