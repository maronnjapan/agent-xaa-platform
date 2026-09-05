import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { WorkDefinition } from '../../work-definition/model.js';
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
 */
export function WorkDefinitionCard(props: WorkDefinitionCardProps): Element {
  const { definition } = props;
  const id = definition.work_definition_id;
  return (
    <article class="work-definition" data-work-definition-id={id} data-status={definition.status}>
      <h3>{definition.purpose}</h3>
      <p data-field="status">{definition.status === 'DRAFT' ? '下書き' : '確定済み'}</p>
      <p data-field="description">{definition.description}</p>
      <dl>
        <dt>作業の手順</dt>
        <dd>
          <ol data-field="operations">{definition.operations.map((step) => <li>{step}</li>)}</ol>
        </dd>
        <dt>確認したいこと</dt>
        <dd>
          <ul data-field="user_confirmations">{definition.user_confirmations.map((item) => <li>{item}</li>)}</ul>
        </dd>
        <dt>注意点</dt>
        <dd>
          <ul data-field="safety_notes">{definition.safety_notes.map((item) => <li>{item}</li>)}</ul>
        </dd>
        <dt>希望する稼働時間</dt>
        <dd data-field="requested_lifetime_hours">{String(definition.requested_lifetime_hours)} 時間</dd>
      </dl>

      {definition.status === 'DRAFT'
        ? (
          <>
            <form data-form="revise" data-work-definition-id={id}>
              <label>
                直してほしいところを書く
                <textarea name="text" rows={2} />
              </label>
              <button type="submit" data-action="revise">書き直してもらう</button>
            </form>
            <button type="button" data-action="confirm" data-work-definition-id={id}>この内容で確定する</button>
          </>
        )
        : null}

      {definition.status === 'CONFIRMED' && !props.agentDefinition
        ? <button type="button" data-action="submit" data-work-definition-id={id}>必要な権限を調べる</button>
        : null}

      {props.agentDefinition ? <AgentDefinitionPanel definition={props.agentDefinition} /> : null}

      <p data-field="action-status" data-status="" />
    </article>
  );
}
