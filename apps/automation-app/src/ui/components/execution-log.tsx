import type { ActivityRecord } from '@xaa/contracts';
import { checkCounts, stepVerdict } from '../records/verdict.js';
import { RecordView } from './record-view.js';
import { RouteStrip } from './route-strip.js';
import { ResultMark, formatDuration } from './visual.js';
import type { Element } from '../element.js';

export const EXECUTION_LOG_HEADING = '実行ログ';
export const EXECUTION_LOG_NOTE = '1手ごとに、選んだ Tool、送った内容、返ってきた内容、実行前の確認が出ます。動いている最中でも読めます。';
export const EXECUTION_LOG_EMPTY = 'まだ何も実行していません。最初の手が終わると、ここに出ます。';

const CHECK_TEXT = { passed: '通過', blocked: '不可', failed: '失敗', skipped: '未実施' } as const;

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
 * The ribbon at the top is the run in one line — a mark per step — and each step
 * below opens with the same mark, the verdicts of its checks, and the route it took
 * drawn as boxes. All three are read off the record: the marks from the checks and hops
 * its publisher wrote, the route from the hops, and not one sentence composed here.
 *
 * The first step is expanded and the rest are folded. A person opening this page is
 * almost always asking about the beginning or about the end; everything in between is
 * one click away, and eight fully-expanded records is a wall nobody reads.
 */
export function ExecutionLog(props: { records: readonly ActivityRecord[] }): Element {
  return (
    <section className="execution-log" data-section="execution-log">
      <div className="section-heading"><h2>{EXECUTION_LOG_HEADING}</h2><span className="muted" data-field="step-count">{`${props.records.length} 手`}</span></div>
      <p className="execution-log-note">{EXECUTION_LOG_NOTE}</p>
      {props.records.length === 0
        ? <p className="execution-log-empty" data-field="execution-log-empty">{EXECUTION_LOG_EMPTY}</p>
        : (
          <>
            <ol className="step-ribbon" data-step-ribbon="true" aria-label="手ごとの結果">
              {props.records.map((record, index) => {
                const step = String(record.step ?? index + 1);
                const verdict = stepVerdict(record);
                return (
                  <li key={`${step}:${index}`} data-step={step} data-verdict={verdict}>
                    <button
                      type="button"
                      className="ribbon-step"
                      data-ribbon-step={step}
                      title={record.headline}
                      onClick={() => scrollTo(document.querySelector<HTMLElement>(`[data-execution-step="${step}"]`))}
                    >
                      <ResultMark outcome={verdict} />
                      <span>{step.padStart(2, '0')}</span>
                      <span className="sr-only">{record.headline}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <ol className="execution-steps">
              {props.records.map((record, index) => {
                const step = String(record.step ?? index + 1);
                const verdict = stepVerdict(record);
                const counts = checkCounts(record);
                return (
                  <li key={`${step}:${index}`} className="execution-step" data-execution-step={step} data-verdict={verdict}>
                    <header className="step-head">
                      <span className="step-order"><ResultMark outcome={verdict} /><span className="step-label">{`${step} 手目`}</span></span>
                      <span className="step-facts">
                        {(Object.keys(CHECK_TEXT) as Array<keyof typeof CHECK_TEXT>).map((result) => (counts[result] === 0 ? null : (
                          <span key={result} className="check-chip" data-check={result}>{CHECK_TEXT[result]} {counts[result]}</span>
                        )))}
                        {typeof record.duration_ms === 'number' ? <span className="step-duration">{formatDuration(record.duration_ms)}</span> : null}
                      </span>
                    </header>
                    {record.hops && record.hops.length > 0 ? <RouteStrip hops={record.hops} /> : null}
                    <RecordView record={record} open={index === 0} />
                  </li>
                );
              })}
            </ol>
          </>
        )}
    </section>
  );
}

/** Scrolls when the document can; a document without the method is a test's, and stays put. */
function scrollTo(target: HTMLElement | null | undefined): void {
  if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
