import { useRef, useState } from 'react';
import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { WorkDefinition } from '../../work-definition/model.js';
import { agentPagePath } from '../../agents/page-link.js';
import { dayRange } from '../actions/home-actions.js';
import { failureMessage } from '../actions/messages.js';
import { reloadPage } from '../actions/navigate.js';
import { createWorkDefinition, type WorkDefinitionBody } from '../actions/work-definition-request.js';
import { WorkDefinitionForm } from '../components/work-definition-form.js';
import { WorkDefinitionCard } from '../components/work-definition-card.js';
import type { Element } from '../element.js';

export interface HomeWorkItem {
  definition: WorkDefinition;
  agentDefinition?: AgentDefinition | undefined;
}

export interface HomeAgent {
  agentId: string;
  purpose: string;
}

export const HOME_LEAD = '自動化したい作業を書き、提示された権限を承認すると Agent が動き出します。';
export const NO_SUGGESTIONS = '候補は見つかりませんでした。作業の内容を自分で書いてください。';

interface Suggestion {
  purpose: string;
  description: string;
  operations: string[];
  user_confirmations: string[];
  safety_notes: string[];
}

/**
 * The screen a person lands on after logging in, and the one place the whole flow
 * happens: describe the work, confirm it, look at the permissions it turned out to
 * need, approve them, and let the agent be created.
 *
 * Every step is a request the person makes. Nothing here advances on a timer, and
 * nothing is decided by the model that helps write the draft — the two irreversible
 * steps, confirming the work and approving the permissions, are separate buttons with
 * the permission set printed between them (RULE-08).
 *
 * The sections are ordered the way the work moves, and each carries its own
 * `data-section` so one can be found without knowing the others.
 */
export function HomePage(props: {
  defaultMinutes: number;
  items: readonly HomeWorkItem[];
  agents: readonly HomeAgent[];
  defaultFrom: string;
  defaultTo: string;
}): Element {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [formStatus, setFormStatus] = useState('');
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [suggestStatus, setSuggestStatus] = useState<{ text: string; state: string }>({ text: '', state: '' });

  const saveDraft = (body: WorkDefinitionBody): void => {
    void (async () => {
      const created = await createWorkDefinition(body);
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
   * person writes, never a draft that got saved on their behalf — which is why it is
   * written into the fields rather than posted.
   */
  const copyInto = (suggestion: Suggestion): void => {
    const form = formRef.current;
    if (!form) return;
    const fill = (name: string, value: string): void => {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = value;
    };
    fill('purpose', suggestion.purpose);
    fill('description', suggestion.description);
    fill('operations', suggestion.operations.join('\n'));
    fill('user_confirmations', suggestion.user_confirmations.join('\n'));
    fill('safety_notes', suggestion.safety_notes.join('\n'));
  };

  return (
    <main className="home" data-page="home">
      <h1>自動化をつくる</h1>
      <p className="lead">{HOME_LEAD}</p>

      <section className="card" data-section="suggest">
        <h2>自動化できそうな作業を探す</h2>
        <p>記録に残っている作業から候補を挙げます。書きたい内容が決まっているなら飛ばして構いません。</p>
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
            <li key={`${index}:${suggestion.purpose}`}>
              <p>{`${suggestion.purpose}：${suggestion.description}`}</p>
              <button type="button" data-action="use-suggestion" onClick={() => copyInto(suggestion)}>この候補を書き写す</button>
            </li>
          ))}
        </ul>
        <p data-field="suggest-status" data-status={suggestStatus.state}>{suggestStatus.text}</p>
      </section>

      <section className="card" data-section="new-work">
        <h2>1. 自動化したい作業を書く</h2>
        <WorkDefinitionForm defaultMinutes={props.defaultMinutes} formRef={formRef} onSubmit={saveDraft} />
        <p data-field="form-status" data-status={formStatus === '' ? '' : 'error'}>{formStatus}</p>
      </section>

      <section className="card" data-section="work-definitions">
        <h2>2. 内容を確定し、提示された権限を承認する</h2>
        {props.items.length === 0
          ? <p data-field="empty">まだ作業がありません。上の欄に書いて保存してください。</p>
          : props.items.map((item) => (
            <WorkDefinitionCard
              key={item.definition.work_definition_id}
              definition={item.definition}
              agentDefinition={item.agentDefinition}
            />
          ))}
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
        <p><a href="/activity">実行の様子をタイムラインで見る</a></p>
      </section>
    </main>
  );
}
