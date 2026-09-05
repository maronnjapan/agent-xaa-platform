import type { Element } from '../element.js';

export const STOP_NOTE = '止めた Agent は元に戻せません。同じ作業をさせるには、作業を定義するところからやり直します。';

/**
 * The two things a person can do to an agent that is already running.
 *
 * There is no third. Nothing here edits what the agent is allowed to do: an agent's
 * permissions are fixed for its life (RULE-13), so a screen offering to widen them
 * would be offering something the platform will not do. An instruction is work, not
 * permission — it is refused by the Runtime if it needs a tool the agent never had.
 *
 * The consequence of stopping is written next to the button rather than behind a
 * dialogue, because a person deciding whether to press it needs it before the click.
 */
export function AgentControls(props: { agentId: string }): Element {
  return (
    <section class="agent-controls" data-section="controls" data-agent-id={props.agentId}>
      <h2>操作</h2>
      <form data-form="instruction" data-agent-id={props.agentId}>
        <label>
          追加で伝えること
          <textarea name="text" rows={2} required />
        </label>
        <button type="submit" data-action="add-instruction">指示を追加する</button>
      </form>
      <p class="stop-note">{STOP_NOTE}</p>
      <button type="button" data-action="stop" data-agent-id={props.agentId}>この Agent を止める</button>
      <p data-field="control-status" data-status="" />
    </section>
  );
}
