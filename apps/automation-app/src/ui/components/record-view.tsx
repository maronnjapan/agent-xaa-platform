import type { ActivityRecord, ActivityRecordCheck, ActivityRecordHop, ActivityRecordSection } from '@xaa/contracts';
import { REPLAY_NODES } from '../replay/nodes.js';
import type { Element } from '../element.js';

/**
 * The breakdown of one event, laid out.
 *
 * Everything with words in it — the headline, each check's label and verdict sentence,
 * each section's label and message, the name beside every value, every hop's label and
 * sentence — was written by the component that produced the event, at the moment it
 * happened. This file chooses headings, order and what starts folded, and writes not
 * one sentence of its own (RULE-54, REQ-11-002).
 *
 * The distinction is easy to lose and expensive to lose. A renderer that turned
 * `status: 403` into 「拒否されました」 would be judging a record it did not make, and
 * would rewrite what a person was told the day the wording changed. So the only
 * Japanese literals here are the fixed captions below, which name parts of the screen
 * rather than anything that happened.
 *
 * What starts open and what starts folded is decided by the shape of the section, not
 * by reading it. A section whose publisher marked its text as prose — the agent's own
 * words, the model's stated reasoning, the instruction a person wrote — is shown in the
 * open, because those sentences are the answer to "what was it thinking". A section
 * whose text is a body (`json`), and any section that is only named values, starts
 * folded: it is there for whoever wants the request, the answer or the token's expiry.
 */

/** Screen furniture: these name the panel, not the event. */
const CHECKS_CAPTION = 'エージェントが実行前に確かめたこと';
export const HOPS_CAPTION = 'やり取りの経路';
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
      {(record.sections ?? []).map((section) => (
        isProse(section)
          ? <ProseView section={section} />
          : <SectionView section={section} open={props.open === true} />
      ))}
      {record.hops && record.hops.length > 0 ? <HopsList hops={record.hops} /> : null}
    </div>
  );
}

/** Prose is what the publisher said it was: `format: 'text'` with something written. */
function isProse(section: ActivityRecordSection): boolean {
  return section.format === 'text' && typeof section.text === 'string' && section.text.trim() !== '';
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
 * Someone's own words, in the open.
 *
 * The label and the message frame it; the text is set as a quotation so it reads as
 * what was said rather than as the screen's own voice. Named values that came with it
 * stay visible too — for the agent's step they are the tool it chose and the arguments
 * it wrote, which is the decision the prose is explaining.
 */
function ProseView(props: { section: ActivityRecordSection }): Element {
  const section = props.section;
  return (
    <section class="record-prose" data-section-id={section.id} data-prose="true">
      <p class="record-prose-label">{section.label}</p>
      {section.message ? <p class="record-message">{section.message}</p> : null}
      <blockquote class="record-quote">{section.text}</blockquote>
      <FieldsTable section={section} />
    </section>
  );
}

/**
 * One section: its own heading, its own sentence, its named values, and its text.
 *
 * A section with a `text` — a request body, an answer — keeps it in a `<pre>` so
 * whitespace survives. The publisher says which of the two formats it is; the renderer
 * does not sniff the content, because a request body that happened to look like prose
 * would then be laid out as prose.
 */
function SectionView(props: { section: ActivityRecordSection; open: boolean }): Element {
  const section = props.section;
  return (
    <details class="record-section" data-section-id={section.id} {...(props.open ? { open: true } : {})}>
      <summary>{section.label}</summary>
      {section.message ? <p class="record-message">{section.message}</p> : null}
      <FieldsTable section={section} />
      {section.text === undefined ? null : (
        <pre class="record-text" data-text-format={section.format ?? 'text'}>{section.text}</pre>
      )}
    </details>
  );
}

function FieldsTable(props: { section: ActivityRecordSection }): Element | null {
  const fields = props.section.fields ?? [];
  if (fields.length === 0) return null;
  return (
    <table class="record-fields">
      <tbody>
        {fields.map((field) => (
          <tr>
            <th scope="row">{field.label}</th>
            <td>{field.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A box's name as the diagram prints it; a source with no box keeps its own name. */
function boxLabel(id: string): string {
  return REPLAY_NODES.find((node) => node.id === id)?.label ?? id;
}

/**
 * The exchanges this step really made, as the publisher listed them — the same hops
 * the canvas animates, so a person who reads rather than watches still learns the
 * route. Folded: the checks and the prose answer the first questions, and the route is
 * what the picture is for.
 */
function HopsList(props: { hops: readonly ActivityRecordHop[] }): Element {
  return (
    <details class="record-hops" data-record-hops="true">
      <summary>{HOPS_CAPTION}</summary>
      <ol>
        {props.hops.map((hop, index) => (
          <li data-hop-index={String(index)} data-hop-outcome={hop.outcome}>
            <span class="hop-route">
              <span class="hop-from">{boxLabel(hop.from)}</span>
              <span class="hop-arrow" aria-hidden="true">→</span>
              <span class="hop-to">{boxLabel(hop.to)}</span>
            </span>
            <span class="hop-label">{hop.label}</span>
            <span class="hop-message">{hop.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
