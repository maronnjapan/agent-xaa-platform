import { Fragment } from 'react';
import { GATE_IDS, type DecisionTrace, type GateAnswer } from '../analysis/trace.js';
import type { Element } from '../element.js';

const ANSWER_TEXT: Readonly<Record<GateAnswer, string>> = {
  yes: 'はい',
  no: 'いいえ',
  pending: '判定中',
  unreached: '—',
};

/** Which gate the AI node sits after, so the list shows it where the path meets it. */
const AI_AFTER: string = GATE_IDS[2];

/**
 * One finding's path through the questions, as a list a person reads top to bottom.
 *
 * The flowchart above the list shows the same path on the whole diagram; this shows it
 * as the questions in order, each with the value the answer was read from. The two
 * come from one trace, so the list can never say a finding went somewhere the picture
 * does not show.
 *
 * Questions the path never reached stay on the list, greyed and unanswered: 「確信度が
 * 70% 以上か」 was not asked of a finding the model never saw, and a list that dropped
 * it would leave a reader thinking the question does not exist.
 */
export function DecisionTraceList(props: { trace: DecisionTrace }): Element {
  const trace = props.trace;
  const aiState = trace.path.includes('analyze')
    ? (trace.current === 'analyze' ? 'pending' : 'yes')
    : 'unreached';
  return (
    <ol className="decision-trace" data-decision-trace="true" aria-label="この検知の判断経路">
      {trace.gates.map((gate) => (
        <Fragment key={gate.id}>
          <li className="trace-gate" data-gate={gate.id} data-answer={gate.answer}>
            <span className="trace-mark" aria-hidden="true">◆</span>
            <span className="trace-question">{gate.question}</span>
            <span className="trace-evidence">{gate.evidence}</span>
            <span className="trace-answer">{ANSWER_TEXT[gate.answer]}</span>
          </li>
          {gate.id === AI_AFTER
            ? (
              <li className="trace-node" data-gate="analyze" data-answer={aiState}>
                <span className="trace-mark" aria-hidden="true">●</span>
                <span className="trace-question">AI 分析を実行</span>
                <span className="trace-evidence" />
                <span className="trace-answer">{aiState === 'yes' ? '実施' : aiState === 'pending' ? '実行中' : '—'}</span>
              </li>
            )
            : null}
        </Fragment>
      ))}
      <li className="trace-end" data-end={trace.end.id} data-tone={trace.end.tone}>
        <span className="trace-mark" aria-hidden="true">■</span>
        <span className="trace-question">{trace.end.label}</span>
      </li>
    </ol>
  );
}
