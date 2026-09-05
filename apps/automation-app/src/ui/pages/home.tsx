import type { AgentDefinition } from '../../agent-definition/approval.js';
import type { WorkDefinition } from '../../work-definition/model.js';
import { agentPagePath } from '../../agents/page-link.js';
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
 * `data-section` so the browser half can find one without knowing the others.
 */
export function HomePage(props: {
  defaultMinutes: number;
  items: readonly HomeWorkItem[];
  agents: readonly HomeAgent[];
  defaultFrom: string;
  defaultTo: string;
}): Element {
  return (
    <main class="home" data-page="home">
      <h1>自動化をつくる</h1>
      <p class="lead">{HOME_LEAD}</p>

      <section class="card" data-section="suggest">
        <h2>自動化できそうな作業を探す</h2>
        <p>記録に残っている作業から候補を挙げます。書きたい内容が決まっているなら飛ばして構いません。</p>
        <form data-form="suggestions">
          <label>
            はじめの日
            <input type="date" name="from" value={props.defaultFrom} />
          </label>
          <label>
            おわりの日
            <input type="date" name="to" value={props.defaultTo} />
          </label>
          <button type="submit" data-action="suggest">候補を挙げてもらう</button>
        </form>
        <ul data-field="suggestions" />
        <p data-field="suggest-status" data-status="" />
      </section>

      <section class="card" data-section="new-work">
        <h2>1. 自動化したい作業を書く</h2>
        <WorkDefinitionForm defaultMinutes={props.defaultMinutes} />
        <p data-field="form-status" data-status="" />
      </section>

      <section class="card" data-section="work-definitions">
        <h2>2. 内容を確定し、提示された権限を承認する</h2>
        {props.items.length === 0
          ? <p data-field="empty">まだ作業がありません。上の欄に書いて保存してください。</p>
          : props.items.map((item) => (
            <WorkDefinitionCard definition={item.definition} agentDefinition={item.agentDefinition} />
          ))}
      </section>

      <section class="card" data-section="running-agents">
        <h2>3. 動き出した Agent</h2>
        {props.agents.length === 0
          ? <p data-field="no-agents">まだ Agent はいません。権限を承認すると作られます。</p>
          : (
            <ul data-field="agent-list">
              {props.agents.map((agent) => (
                <li data-agent-id={agent.agentId}>
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
