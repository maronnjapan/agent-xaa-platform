import { useRef, useState } from 'react';
import { agentInstructionsPath, agentStopPath } from '../../agents/page-link.js';
import { failureMessage } from '../actions/messages.js';
import type { Element } from '../element.js';

export const STOP_NOTE = '止めた Agent は元に戻せません。同じ作業をさせるには作り直します。';

/**
 * What the button says once the Lifecycle Manager has taken the stop.
 *
 * A 200 here means the request was accepted, and the destruction — cancelling the Job
 * Execution, revoking the credentials — runs on the Lifecycle Manager's side after the
 * answer. The sentence says both halves, because a person who pressed an irreversible
 * button and read only 「止めました」 would still be wondering what is left running.
 */
export const STOP_ACCEPTED = '止めました。Lifecycle Manager が実行を終了し、資格情報を失効させます。';
export const INSTRUCTION_ADDED = '指示を追加しました。Agent が次の区切りで読み取ります。';

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
 *
 * The stop is the one operation in this app that says it worked rather than re-reading
 * the page. Every other button answers a success by reloading, because the state it
 * changed lives on the server. This one cannot: a stopped agent is destroyed, its
 * registration goes, and the ownership guard every screen runs behind answers 404 for
 * an agent that is no longer there. Reloading would race the cleanup and land the
 * person on a JSON refusal for the agent they had just successfully stopped. So the
 * answer is shown where the refusals are shown, and the button stays disabled: there
 * is nothing left to press.
 */
export function AgentControls(props: { agentId: string }): Element {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [status, setStatus] = useState<{ text: string; state: string }>({ text: '', state: '' });
  const [stopping, setStopping] = useState(false);

  const instruct = (text: string): void => {
    if (text.trim() === '') return;
    void (async () => {
      const response = await fetch(agentInstructionsPath(props.agentId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setStatus({ text: failureMessage(response.status, body), state: 'error' });
        return;
      }
      if (textRef.current) textRef.current.value = '';
      setStatus({ text: INSTRUCTION_ADDED, state: 'done' });
    })();
  };

  const halt = (): void => {
    setStopping(true);
    void (async () => {
      const response = await fetch(agentStopPath(props.agentId), {
        method: 'POST', credentials: 'same-origin',
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setStopping(false);
        setStatus({ text: failureMessage(response.status, body), state: 'error' });
        return;
      }
      setStatus({ text: STOP_ACCEPTED, state: 'done' });
    })();
  };

  return (
    <section className="agent-controls" data-section="controls" data-agent-id={props.agentId}>
      <h2>操作</h2>
      <form
        data-form="instruction"
        data-agent-id={props.agentId}
        onSubmit={(event) => {
          event.preventDefault();
          instruct(String(new FormData(event.currentTarget).get('text') ?? ''));
        }}
      >
        <label>
          追加で伝えること
          <textarea name="text" rows={2} required ref={textRef} />
        </label>
        <button type="submit" data-action="add-instruction">指示を追加する</button>
      </form>
      <p className="stop-note">{STOP_NOTE}</p>
      <button type="button" data-action="stop" data-agent-id={props.agentId} disabled={stopping} onClick={halt}>
        この Agent を止める
      </button>
      <p data-field="control-status" data-status={status.state}>{status.text}</p>
    </section>
  );
}
