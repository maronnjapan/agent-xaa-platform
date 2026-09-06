import type { SecurityFindingView } from '@xaa/contracts';
import { agentPagePath } from '../../agents/page-link.js';
import { FindingCard } from '../components/finding-card.js';
import type { Element } from '../element.js';

export interface AgentAnalysis {
  agentId: string;
  /** Empty for an agent named only by a finding; the id stands in as the heading. */
  purpose: string;
  findings: SecurityFindingView[];
}

export const SECURITY_LEAD =
  'Agent が動くたび、ログを分析するエージェントがその挙動を見ています。この画面は、その分析が下した判断をそのまま並べたものです。';
export const SECURITY_SCOPE_NOTE = '表示するのはあなた自身の Agent だけです。他の人の Agent は出ません。';
export const SECURITY_EMPTY = 'まだ Agent がありません。作業を書いて Agent を作ると、ここに並びます。';
export const SECURITY_CLEAR = '気になる挙動は記録されていません。';

/**
 * What the log analyser concluded about this person's agents.
 *
 * It shows judgements and makes none. Every quarantine, every score and every one of the
 * model's four aspects on this page was decided by Security Detection before the page
 * was asked for, and nothing here can change any of it — there is no approve button and
 * no dismiss (RULE-54). The one thing a person can do from here is open the agent, which
 * is where the operations live.
 *
 * The scope is the session's own subject and nothing wider (RULE-56). A platform-wide
 * view — every agent of every person — is what an operator would want and is deliberately
 * not this: it needs an operator role this platform does not have yet, and building the
 * screen before the role would mean deciding who may look at it here, in a page.
 *
 * An agent with nothing against it keeps its section and says so. 「何も見つからなかった」
 * and 「一度も見られていない」 are different answers, and a screen that listed only the
 * agents with findings would leave a person unable to tell which one they are reading.
 */
export function SecurityPage(props: { agents: readonly AgentAnalysis[] }): Element {
  return (
    <main className="security" data-page="security">
      <h1>分析エージェントの判断</h1>
      <p className="lead">{SECURITY_LEAD}</p>
      <p className="note">{SECURITY_SCOPE_NOTE}</p>

      {props.agents.length === 0
        ? <p data-field="empty">{SECURITY_EMPTY}</p>
        : props.agents.map((agent) => (
          <section className="card" key={agent.agentId} data-agent-id={agent.agentId}>
            <h2>{agent.purpose === '' ? agent.agentId : agent.purpose}</h2>
            <p className="finding-agent">
              <a href={agentPagePath(agent.agentId)}>{agent.agentId}</a>
            </p>
            {agent.findings.length === 0
              ? <p data-field="findings" data-state="clear">{SECURITY_CLEAR}</p>
              : (
                <ol className="findings" data-field="findings" data-state="found">
                  {agent.findings.map((finding) => (
                    <FindingCard key={finding.finding_id} finding={finding} />
                  ))}
                </ol>
              )}
          </section>
        ))}
    </main>
  );
}
