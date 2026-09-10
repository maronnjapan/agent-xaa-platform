import type { SecurityFindingView, SecurityInspectionView } from '@xaa/contracts';
import { FindingCard } from '../components/finding-card.js';
import { INSPECTION_HEADING, InspectionCard } from '../components/inspection-card.js';
import type { Element } from '../element.js';

export interface AgentAnalysis {
  agentId: string;
  /** The Provisioner's word for what became of it, or empty when it is gone. */
  status: string;
  findings: SecurityFindingView[];
  /**
   * The mechanical passes over this agent's logs, newest window first. Present even when
   * `findings` is empty — that is the case it exists for.
   */
  inspections: SecurityInspectionView[];
}

export const CONSOLE_LEAD =
  'Agent が動くたび、ログを分析するエージェントがその挙動を見ています。この画面は、その分析が下した判断をそのまま並べたものです。';
export const CONSOLE_SCOPE_NOTE = '表示するのはあなた自身の Agent だけです。他の人の Agent は出ません。';
export const CONSOLE_EMPTY = 'あなたの Agent のログは、まだ分析エージェントに届いていません。';
export const CONSOLE_NO_FINDINGS = '指摘はありません。下の記録が、読んだログと通したチェックです。';
export const CONSOLE_AGENT_GONE = 'この Agent はすでに終了しています。';

/**
 * What the log analyser concluded about this person's agents.
 *
 * It shows judgements and makes none. Every score, every quarantine and every one of the
 * model's four aspects on this page was decided by Security Detection before the page
 * was asked for, and nothing here can change any of it — there is no approve button and
 * no dismiss (RULE-54). Operating an agent is the Automation App's screen, which each
 * heading links to.
 *
 * The scope is the session's own subject and nothing wider (RULE-56). A platform-wide
 * view — every agent of every person — is what an operator would want and is deliberately
 * not this: it needs an operator role this platform does not have yet, and building the
 * screen before the role would mean deciding who may look at it here, in a page.
 *
 * Only agents the analyser has actually read logs for appear. This console is not an
 * agent list — the Automation App has one — and padding it with every agent that never
 * ran would bury the ones that did.
 *
 * An agent with no finding still gets a card, because 「見て、何もなかった」 is an answer
 * and a blank page is not. What is under it then is the inspection record and nothing
 * else: this screen never writes a reassurance of its own over a clean window.
 */
export function FindingsPage(props: {
  agents: readonly AgentAnalysis[];
  automationAppUrl: string;
}): Element {
  return (
    <main className="console" data-page="findings">
      <h1>分析エージェントの判断</h1>
      <p className="lead">{CONSOLE_LEAD}</p>
      <p className="note">{CONSOLE_SCOPE_NOTE}</p>

      {props.agents.length === 0
        ? <p data-field="empty">{CONSOLE_EMPTY}</p>
        : props.agents.map((agent) => (
          <section className="card" key={agent.agentId} data-agent-id={agent.agentId}>
            <h2>
              <a href={`${props.automationAppUrl}/agents/${encodeURIComponent(agent.agentId)}`}>{agent.agentId}</a>
            </h2>
            <p className="agent-state" data-field="status">
              {agent.status === '' ? CONSOLE_AGENT_GONE : agent.status}
            </p>
            {agent.findings.length === 0
              ? <p className="note" data-field="no-findings">{CONSOLE_NO_FINDINGS}</p>
              : (
                <ol className="findings" data-field="findings">
                  {agent.findings.map((finding) => (
                    <FindingCard key={finding.finding_id} finding={finding} />
                  ))}
                </ol>
              )}

            {agent.inspections.length === 0
              ? null
              : (
                <details className="inspections" data-field="inspections">
                  <summary>{INSPECTION_HEADING}</summary>
                  <ol>
                    {agent.inspections.map((inspection) => (
                      <InspectionCard key={inspection.inspection_id} inspection={inspection} />
                    ))}
                  </ol>
                </details>
              )}
          </section>
        ))}
    </main>
  );
}
