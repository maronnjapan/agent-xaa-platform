import { useState } from 'react';
import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { WorkDefinition } from '../../work-definition/model.js';
import { agentPagePath } from '../../agents/page-link.js';
import { actionUrl, afterProvision, type HomeAction } from '../actions/home-actions.js';
import { failureMessage } from '../actions/messages.js';
import { navigateTo, reloadPage } from '../actions/navigate.js';
import { updateTodo, type TodoBody } from '../actions/todo-request.js';
import { AgentDefinitionPanel } from './agent-definition-panel.js';
import { TodoForm } from './todo-form.js';
import { isClosedStatus, PRIORITY_LABELS, SOURCE_LABELS, STATUS_LABELS, TERMINAL_OUTCOME_LABELS } from './todo-labels.js';
import type { Element } from '../element.js';

/** The agent carrying a ToDo, as the card shows it: a snapshot and, once there is one, a verdict. */
export interface TodoAgentView {
  agentId: string;
  status: string;
  remainingSeconds: number;
  /** The Runtime's terminal verdict on its task, once the timeline has it. */
  outcome: string | null;
  completedAt: string | null;
}

export interface TodoCardProps {
  definition: WorkDefinition;
  /** The permissions this ToDo turned out to need, once they have been asked for. */
  agentDefinition?: AgentDefinition | undefined;
  agent?: TodoAgentView | undefined;
  defaultMinutes: number;
  /** The server's date, so overdue is judged the same way on both renders. */
  today: string;
}

export const CANCEL_NOTE = '取り下げた ToDo は元に戻せません。';
export const AGENT_RUNNING_NOTE = 'Agent が動いています。取り下げるには、先に Agent の画面で止めてください。';

/**
 * One ToDo, and the next things a person can do with it.
 *
 * The card follows the record's own state, so the screen cannot invite a step the
 * server would refuse: a draft can be edited, rewritten by the model, confirmed or
 * withdrawn; a confirmed ToDo can be sent for a decision, and a decision approved and
 * then provisioned; a ToDo in progress shows the agent carrying it and can be marked
 * done, or withdrawn once that agent has stopped. A closed ToDo shows when it closed.
 *
 * `status` moves only through the confirm, complete and cancel buttons. The rewrite box
 * talks to the Automation Design AI, and that endpoint has no branch that writes
 * `status` — a model that answers "confirmed" changes the wording and nothing else
 * (RULE-08). The agent's verdict is printed, not acted on: an agent that says it
 * finished does not close the ToDo, the person does.
 *
 * Every button is one request, and every success re-reads the page. A refusal is shown
 * in the words the server used, in this card and not on some other one: the message
 * state belongs to the card, which is why it is here rather than on the page.
 */
export function TodoCard(props: TodoCardProps): Element {
  const { definition, agent } = props;
  const id = definition.work_definition_id;
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const open = !isClosedStatus(definition.status);
  const overdue = open && definition.due_on !== null && definition.due_on < props.today;

  const run = (action: HomeAction, target: string): void => {
    setBusy(true);
    void (async () => {
      const response = await fetch(actionUrl(action, target), { method: 'POST', credentials: 'same-origin' });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        setBusy(false);
        setStatus(failureMessage(response.status, body));
        return;
      }
      // Provisioning is the one answer that can send the browser elsewhere: to the
      // consent screen the Provisioner named, or to the agent that now exists.
      if (action !== 'provision') return reloadPage();
      const outcome = afterProvision(body);
      if (outcome.kind === 'navigate' && outcome.url) return navigateTo(outcome.url);
      reloadPage();
    })();
  };

  const revise = (text: string): void => {
    if (text.trim() === '') return;
    void (async () => {
      const response = await fetch(`/api/todos/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      if (response.ok) return reloadPage();
      const body = await response.json().catch(() => ({})) as { error?: string };
      setStatus(failureMessage(response.status, body));
    })();
  };

  const edit = (body: TodoBody): void => {
    void (async () => {
      const saved = await updateTodo(id, body);
      if (saved.ok) return reloadPage();
      setStatus(failureMessage(saved.status, saved.body));
    })();
  };

  const list = (field: string, values: readonly string[]): Element => (
    values.length === 0
      ? <span data-field={field} className="todo-empty">—</span>
      : <ul data-field={field}>{values.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
  );

  return (
    <article
      className="todo"
      data-todo-id={id}
      data-status={definition.status}
      data-priority={definition.priority}
      data-source={definition.source}
    >
      <header className="todo-head">
        <h3>{definition.title}</h3>
        <p className="todo-meta">
          <span data-field="status" className="todo-status">{STATUS_LABELS[definition.status]}</span>
          <span data-field="priority">優先度 {PRIORITY_LABELS[definition.priority]}</span>
          {definition.due_on !== null
            ? <span data-field="due_on" data-overdue={String(overdue)}>{`期限 ${definition.due_on}${overdue ? '（期限切れ）' : ''}`}</span>
            : null}
          <span data-field="source">{SOURCE_LABELS[definition.source]}</span>
        </p>
      </header>
      <p data-field="description">{definition.description}</p>
      {definition.context !== ''
        ? (
          <details className="todo-context" data-field="context">
            <summary>実行時のコンテキスト</summary>
            <pre>{definition.context}</pre>
          </details>
        )
        : null}
      <dl>
        <dt>完了条件</dt>
        <dd>{list('done_criteria', definition.done_criteria)}</dd>
        <dt>手順</dt>
        <dd>{list('steps', definition.steps)}</dd>
        <dt>注意点</dt>
        <dd>{list('notes', definition.notes)}</dd>
        <dt>希望する稼働時間</dt>
        <dd data-field="requested_lifetime_minutes">{String(definition.requested_lifetime_minutes)} 分</dd>
      </dl>

      {agent
        ? (
          <section className="todo-agent" data-section="todo-agent" data-agent-status={agent.status}>
            <p>
              <a href={agentPagePath(agent.agentId)} data-field="agent-link">この ToDo を実行している Agent</a>
              ：<span data-field="agent-status">{agent.status}</span>
              {agent.status === 'ACTIVE' ? <span data-field="remaining">{`（残り ${String(agent.remainingSeconds)} 秒）`}</span> : null}
            </p>
            {agent.outcome !== null
              ? (
                <p data-field="agent-outcome" data-outcome={agent.outcome}>
                  {`${TERMINAL_OUTCOME_LABELS[agent.outcome] ?? agent.outcome}${agent.completedAt ? `（${agent.completedAt}）` : ''}。詳しくは`}
                  <a href={`/activity?agent_id=${encodeURIComponent(agent.agentId)}`}>タイムライン</a>
                  へ。
                </p>
              )
              : <p data-field="agent-outcome" data-outcome="">まだ結果は出ていません。途中経過は Agent の画面の実行ログにあります。</p>}
          </section>
        )
        : null}

      {definition.status === 'DRAFT'
        ? (
          <>
            <form
              data-form="revise"
              data-todo-id={id}
              onSubmit={(event) => {
                event.preventDefault();
                revise(String(new FormData(event.currentTarget).get('text') ?? ''));
              }}
            >
              <label>
                直してほしいところを書く（AI が文面を書き直します）
                <textarea name="text" rows={2} />
              </label>
              <button type="submit" data-action="revise">書き直してもらう</button>
            </form>
            <details className="todo-edit" data-section="edit">
              <summary>自分で書き直す</summary>
              <TodoForm
                defaultMinutes={props.defaultMinutes}
                initial={definition}
                submitLabel="この内容で保存する"
                onSubmit={edit}
              />
            </details>
            <div className="todo-actions">
              <button type="button" data-action="confirm" data-todo-id={id} disabled={busy} onClick={() => run('confirm', id)}>
                この内容で確定する
              </button>
              <CancelButton id={id} busy={busy} onCancel={() => run('cancel', id)} />
            </div>
          </>
        )
        : null}

      {definition.status === 'CONFIRMED' && !props.agentDefinition
        ? (
          <div className="todo-actions">
            <button type="button" data-action="submit" data-todo-id={id} disabled={busy} onClick={() => run('submit', id)}>
              必要な権限を調べる
            </button>
          </div>
        )
        : null}

      {definition.status === 'CONFIRMED' && props.agentDefinition
        ? <AgentDefinitionPanel definition={props.agentDefinition} busy={busy} onAct={run} />
        : null}

      {definition.status === 'CONFIRMED' || definition.status === 'IN_PROGRESS'
        ? (
          <div className="todo-actions todo-close">
            <button type="button" data-action="complete" data-todo-id={id} disabled={busy} onClick={() => run('complete', id)}>
              完了にする
            </button>
            {definition.status === 'IN_PROGRESS' && agent?.status === 'ACTIVE'
              ? <p className="todo-note" data-field="agent-running-note">{AGENT_RUNNING_NOTE}</p>
              : <CancelButton id={id} busy={busy} onCancel={() => run('cancel', id)} />}
          </div>
        )
        : null}

      {!open
        ? <p data-field="completed_at" className="todo-closed">{STATUS_LABELS[definition.status]}：{definition.completed_at ?? ''}</p>
        : null}

      <p data-field="action-status" data-status={status === '' ? '' : 'error'}>{status}</p>
    </article>
  );
}

function CancelButton(props: { id: string; busy: boolean; onCancel: () => void }): Element {
  return (
    <span className="todo-cancel">
      <button type="button" className="secondary" data-action="cancel" data-todo-id={props.id} disabled={props.busy} onClick={props.onCancel}>
        取り下げる
      </button>
      <span className="todo-note">{CANCEL_NOTE}</span>
    </span>
  );
}
