import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { Element } from '../element.js';

export const APPROVAL_NOTE = '承認するまで Agent は作られません。内容を読んでから承認してください。';

/**
 * What the Authorization Platform decided, shown to the person who has to agree to it.
 *
 * The permissions are printed as they arrived: this app does not know what any of
 * these strings mean and must not learn (RULE-07), so there is no grouping, no
 * plain-language rewrite and no judgement about which of them matter. The isolation
 * level is a label for the same reason.
 *
 * Approval and provisioning are two buttons rather than one. The gap between them is
 * the whole point of RULE-08: the set below is hashed at the moment it is approved,
 * and provisioning is refused if it has moved since.
 */
export function AgentDefinitionPanel(props: { definition: AgentDefinition }): Element {
  const approved = props.definition.approved_at !== null;
  return (
    <section
      class="agent-definition"
      data-section="agent-definition"
      data-agent-definition-id={props.definition.agent_definition_id}
      data-approved={String(approved)}
    >
      <h4>提示された Agent Definition</h4>
      <dl>
        <dt>この Agent に許可される操作</dt>
        <dd>
          <ul data-field="presented-capabilities">
            {props.definition.presented_capabilities.map((capability) => (
              <li data-capability={capability}>{capability}</li>
            ))}
          </ul>
        </dd>
        <dt>隔離のレベル</dt>
        <dd data-field="isolation-level">{props.definition.isolation_level}</dd>
      </dl>
      {approved
        ? (
          <>
            <p data-field="approved-at">{props.definition.approved_at} に承認しました。</p>
            <button
              type="button"
              data-action="provision"
              data-agent-definition-id={props.definition.agent_definition_id}
            >
              この内容で Agent を作る
            </button>
          </>
        )
        : (
          <>
            <p data-field="approval-note">{APPROVAL_NOTE}</p>
            <button
              type="button"
              data-action="approve"
              data-agent-definition-id={props.definition.agent_definition_id}
            >
              この権限で承認する
            </button>
          </>
        )}
    </section>
  );
}
