import type { ActivityRecord } from '@xaa/contracts';
import { RecordView } from './record-view.js';
import type { Element } from '../element.js';

export const EXECUTION_LOG_HEADING = '実行ログ';
export const EXECUTION_LOG_NOTE = 'Agent が1手ごとに何を選び、どこへ何を送り、何が返り、実行前に何を確かめたかです。Agent 自身が書いた文章もそのまま載せています。';
export const EXECUTION_LOG_EMPTY = 'まだ何も実行していません。最初の手が終わると、ここに出ます。';

/**
 * What the agent has done, on the agent's own screen, while it is still doing it.
 *
 * This and the timeline are the same records read from two places, and the difference
 * is deliberate: the timeline replays a task once it has ended (RULE-59), so it can
 * show the whole shape of it; this reads the checkpoint, which is rewritten after every
 * step, so it can show a run that is still going. Someone watching an eight-step agent
 * should not have to wait for it to finish to find out it spent three steps being
 * refused.
 *
 * The first step is expanded and the rest are folded. A person opening this page is
 * almost always asking about the beginning or about the end; everything in between is
 * one click away, and eight fully-expanded records is a wall nobody reads.
 */
export function ExecutionLog(props: { records: readonly ActivityRecord[] }): Element {
  return (
    <section class="execution-log" data-section="execution-log">
      <h2>{EXECUTION_LOG_HEADING}</h2>
      <p class="execution-log-note">{EXECUTION_LOG_NOTE}</p>
      {props.records.length === 0
        ? <p class="execution-log-empty" data-field="execution-log-empty">{EXECUTION_LOG_EMPTY}</p>
        : (
          <ol class="execution-steps">
            {props.records.map((record, index) => (
              <li class="execution-step" data-execution-step={String(record.step ?? index + 1)}>
                <RecordView record={record} open={index === 0} />
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}
