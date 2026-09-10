import type { ActivityRecordCheck } from '@xaa/contracts';
import type { ThinkingFrame } from '../replay/thinking.js';
import { hasThinking } from '../replay/thinking.js';
import type { Element } from '../element.js';

/**
 * Screen furniture: the two beats of a decision, named. Each names a part of the
 * panel; none of them says anything about any event (RULE-54).
 */
export const THINKING_CAPTION = 'この手で Agent が考えたこと';
export const THINKING_HEADINGS = {
  thought: '考えたこと',
  checks: '実行前に確かめたこと',
} as const;

export const THINKING_IDLE = '再生を押すと、その手で Agent が考えたことがここに出ます。';
export const THINKING_NONE = 'この手の内訳は残っていません。図に添えた説明が全部です。';
export const THINKING_READ_MORE = 'このできごとの記録を読む';

/** The four verdicts a check can carry, as the record spells them. */
const CHECK_MARKS: Readonly<Record<ActivityRecordCheck['result'], string>> = {
  passed: '通過',
  blocked: '不可',
  failed: '失敗',
  skipped: '未実施',
};

/**
 * What the agent was thinking on the step the picture is on, in brief.
 *
 * The diagram answers "what went where". This answers the question people actually
 * asked of it — 「AI エージェントがどういうことを考えて、どうするかを決めたのか」 — beside
 * the picture, on the same step, while it moves. It says two things and no more: the
 * agent's own words, set as a quotation, and what it made sure of before anything left
 * the process, each with its verdict. A person who wants the rest — what the step was
 * handed, the values it chose, the request it sent — follows the one link at the foot,
 * which opens the written account on this very event. Beside a moving picture, more
 * than this is a second thing to read while the first one moves.
 *
 * Every sentence in it is a `label`, a `message` or a `text` the publisher wrote. The
 * panel supplies two headings and the marks beside the verdicts, and not one sentence
 * about what happened (RULE-54, REQ-11-002).
 */
export function ThinkingPanel(props: {
  frame?: ThinkingFrame | null;
  taskKey?: string;
  /** Where the written account of this event is; the link is offered only when given. */
  readMoreHref?: string;
  onReadMore?: () => void;
}): Element {
  const frame = props.frame ?? null;
  return (
    <aside
      className="thinking"
      data-thinking="true"
      {...(props.taskKey ? { 'data-thinking-key': props.taskKey } : {})}
      data-thinking-state={frame ? 'playing' : 'idle'}
      aria-live="polite"
    >
      <h4 className="thinking-caption">{THINKING_CAPTION}</h4>
      {frame === null
        ? <p className="thinking-idle" data-field="thinking-idle">{THINKING_IDLE}</p>
        : <ThinkingBody frame={frame} {...(props.readMoreHref ? { readMoreHref: props.readMoreHref } : {})} {...(props.onReadMore ? { onReadMore: props.onReadMore } : {})} />}
    </aside>
  );
}

/**
 * Keyed by the event, so a new event is a new element and the stylesheet can slide it
 * in; drawn as plain markup, so the server renders it complete for a page that opens on
 * a step and a browser without script reads it as it is.
 */
function ThinkingBody(props: { frame: ThinkingFrame; readMoreHref?: string; onReadMore?: () => void }): Element {
  const frame = props.frame;
  return (
    <div key={frame.eventId} className="thinking-body" data-thinking-event={frame.eventId}>
      <p className="thinking-who" data-field="thinking-who">
        {frame.actor
          ? (
            <>
              <span className="thinking-actor" title={frame.actor.label}>{frame.actor.name}</span>
              <span className="thinking-actor-role">{frame.actor.role}</span>
            </>
          )
          : <span className="thinking-actor">{frame.source}</span>}
        {frame.step === null ? null : <span className="thinking-step" data-field="thinking-step">{`${frame.step} 手目`}</span>}
      </p>
      {frame.headline === ''
        ? null
        : <p className="thinking-headline" data-field="thinking-headline">{frame.headline}</p>}

      {frame.thought.length === 0
        ? null
        : (
          <section className="thinking-beat" data-beat="thought">
            <h5 className="thinking-beat-heading">{THINKING_HEADINGS.thought}</h5>
            {frame.thought.map((block) => (
              <div key={block.id} className="thinking-block" data-block-id={block.id}>
                <p className="thinking-label">{block.label}</p>
                {block.message === '' ? null : <p className="thinking-message">{block.message}</p>}
                <blockquote className="thinking-quote" data-field="thinking-quote">{block.text}</blockquote>
              </div>
            ))}
          </section>
        )}
      <Checks checks={frame.checks} />

      {hasThinking(frame)
        ? null
        : <p className="thinking-none" data-field="thinking-none">{THINKING_NONE}</p>}

      {props.readMoreHref
        ? (
          <p className="thinking-more">
            <a
              href={props.readMoreHref}
              data-action="thinking-read-more"
              onClick={props.onReadMore
                ? (event) => { event.preventDefault(); props.onReadMore?.(); }
                : undefined}
            >
              {THINKING_READ_MORE}
            </a>
          </p>
        )
        : null}
    </div>
  );
}

/**
 * The checks, each with its verdict. They are never behind a disclosure: they are the
 * answer to "did anything actually stop this".
 */
function Checks(props: { checks: readonly ActivityRecordCheck[] }): Element {
  if (props.checks.length === 0) return null;
  return (
    <section className="thinking-beat" data-beat="checks">
      <h5 className="thinking-beat-heading">{THINKING_HEADINGS.checks}</h5>
      <ul className="thinking-checks">
        {props.checks.map((check) => (
          <li key={check.id} data-check-id={check.id} data-check-result={check.result}>
            <span className="check-mark" data-check-mark={check.result}>{CHECK_MARKS[check.result]}</span>
            <span className="check-label">{check.label}</span>
            <span className="check-message">{check.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
