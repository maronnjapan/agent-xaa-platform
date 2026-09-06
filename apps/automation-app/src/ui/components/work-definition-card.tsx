import { useState } from 'react';
import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { WorkDefinition } from '../../work-definition/model.js';
import { actionUrl, afterProvision, type HomeAction } from '../actions/home-actions.js';
import { failureMessage } from '../actions/messages.js';
import { navigateTo, reloadPage } from '../actions/navigate.js';
import { AgentDefinitionPanel } from './agent-definition-panel.js';
import type { Element } from '../element.js';

export interface WorkDefinitionCardProps {
  definition: WorkDefinition;
  /** The permissions this work turned out to need, once they have been asked for. */
  agentDefinition?: AgentDefinition | undefined;
}

/**
 * One piece of work, and the single next thing a person can do with it.
 *
 * The card shows one action, never a menu: a draft can be rewritten or confirmed, a
 * confirmed definition can be sent for a decision, and a decision can be approved and
 * then provisioned. Which one is offered follows the record's own state, so the screen
 * cannot invite a step the server would refuse.
 *
 * `status` moves only through the confirm button. The rewrite box talks to the
 * Automation Design AI, and that endpoint has no branch that writes `status` — a model
 * that answers "confirmed" changes the wording of the draft and nothing else (RULE-08).
 *
 * Every button is one POST, and every success re-reads the page. A refusal is shown in
 * the words the server used, in this card and not on some other one: the message state
 * belongs to the card, which is why it is here rather than on the page.
 */
export function WorkDefinitionCard(props: WorkDefinitionCardProps): Element {
  const { definition } = props;
  const id = definition.work_definition_id;
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

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
      const response = await fetch(`/api/work-definitions/${encodeURIComponent(id)}/messages`, {
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

  return (
    <article className="work-definition" data-work-definition-id={id} data-status={definition.status}>
      <h3>{definition.purpose}</h3>
      <p data-field="status">{definition.status === 'DRAFT' ? '下書き' : '確定済み'}</p>
      <p data-field="description">{definition.description}</p>
      <dl>
        <dt>作業の手順</dt>
        <dd>
          <ol data-field="operations">{definition.operations.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}</ol>
        </dd>
        <dt>確認したいこと</dt>
        <dd>
          <ul data-field="user_confirmations">{definition.user_confirmations.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
        </dd>
        <dt>注意点</dt>
        <dd>
          <ul data-field="safety_notes">{definition.safety_notes.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
        </dd>
        <dt>希望する稼働時間</dt>
        <dd data-field="requested_lifetime_minutes">{String(definition.requested_lifetime_minutes)} 分</dd>
      </dl>

      {definition.status === 'DRAFT'
        ? (
          <>
            <form
              data-form="revise"
              data-work-definition-id={id}
              onSubmit={(event) => {
                event.preventDefault();
                revise(String(new FormData(event.currentTarget).get('text') ?? ''));
              }}
            >
              <label>
                直してほしいところを書く
                <textarea name="text" rows={2} />
              </label>
              <button type="submit" data-action="revise">書き直してもらう</button>
            </form>
            <button
              type="button"
              data-action="confirm"
              data-work-definition-id={id}
              disabled={busy}
              onClick={() => run('confirm', id)}
            >
              この内容で確定する
            </button>
          </>
        )
        : null}

      {definition.status === 'CONFIRMED' && !props.agentDefinition
        ? (
          <button
            type="button"
            data-action="submit"
            data-work-definition-id={id}
            disabled={busy}
            onClick={() => run('submit', id)}
          >
            必要な権限を調べる
          </button>
        )
        : null}

      {props.agentDefinition
        ? <AgentDefinitionPanel definition={props.agentDefinition} busy={busy} onAct={run} />
        : null}

      <p data-field="action-status" data-status={status === '' ? '' : 'error'}>{status}</p>
    </article>
  );
}
