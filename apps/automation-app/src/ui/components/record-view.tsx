import type { ActivityRecord, ActivityRecordCheck, ActivityRecordSection } from '@xaa/contracts';
import type { Element } from '../element.js';

/**
 * The breakdown of one event, laid out.
 *
 * Everything with words in it — the headline, each check's label and verdict sentence,
 * each section's label and message, the name beside every value — was written by the
 * component that produced the event, at the moment it happened. This file chooses
 * headings, order and what starts folded, and writes not one sentence of its own
 * (RULE-54, REQ-11-002).
 *
 * The distinction is easy to lose and expensive to lose. A renderer that turned
 * `status: 403` into 「拒否されました」 would be judging a record it did not make, and
 * would rewrite what a person was told the day the wording changed. So the only
 * Japanese literals here are the three fixed captions below, which name parts of the
 * screen rather than anything that happened.
 */

/** Screen furniture: these name the panel, not the event. */
const CHECKS_CAPTION = 'エージェントが実行前に確かめたこと';
export const RECORD_EMPTY_CAPTION = 'この処理には内訳がありません。';

const CHECK_MARKS: Readonly<Record<ActivityRecordCheck['result'], string>> = {
  passed: '通過',
  blocked: '不可',
  failed: '失敗',
  skipped: '未実施',
};

export function RecordView(props: { record?: ActivityRecord; open?: boolean }): Element | null {
  const record = props.record;
  if (!record) return null;
  return (
    <div class="record" data-record="true">
      <p class="record-headline" data-field="record-headline">{record.headline}</p>
      {record.checks && record.checks.length > 0 ? <ChecksTable checks={record.checks} /> : null}
      {(record.sections ?? []).map((section) => <SectionView section={section} open={props.open === true} />)}
    </div>
  );
}

/**
 * The checks, open by default and never behind a disclosure.
 *
 * They are the answer to "did anything actually stop this", and a person who has to
 * open something to find out will not. The technical values stay folded below; the
 * verdicts do not.
 */
function ChecksTable(props: { checks: readonly ActivityRecordCheck[] }): Element {
  return (
    <section class="record-checks" data-record-checks="true">
      <h4>{CHECKS_CAPTION}</h4>
      <ul>
        {props.checks.map((check) => (
          <li data-check-id={check.id} data-check-result={check.result}>
            <span class="check-mark" data-check-mark={check.result}>{CHECK_MARKS[check.result]}</span>
            <span class="check-label">{check.label}</span>
            <span class="check-message">{check.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One section: its own heading, its own sentence, its named values, and its text.
 *
 * A section with a `text` — a request body, an answer, the agent's own words — keeps
 * it in a `<pre>` so whitespace survives. The publisher says which of the two formats
 * it is; the renderer does not sniff the content, because a request body that happened
 * to look like prose would then be laid out as prose.
 */
function SectionView(props: { section: ActivityRecordSection; open: boolean }): Element {
  const section = props.section;
  return (
    <details class="record-section" data-section-id={section.id} {...(props.open ? { open: true } : {})}>
      <summary>{section.label}</summary>
      {section.message ? <p class="record-message">{section.message}</p> : null}
      {section.fields && section.fields.length > 0 ? (
        <table class="record-fields">
          <tbody>
            {section.fields.map((field) => (
              <tr>
                <th scope="row">{field.label}</th>
                <td>{field.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {section.text === undefined ? null : (
        <pre class="record-text" data-text-format={section.format ?? 'text'}>{section.text}</pre>
      )}
    </details>
  );
}
