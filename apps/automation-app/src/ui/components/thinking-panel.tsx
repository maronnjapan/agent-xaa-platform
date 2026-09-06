import { AnimatePresence, motion } from 'motion/react';
import type { ActivityRecordCheck } from '@xaa/contracts';
import type { ThinkingBlock, ThinkingFrame } from '../replay/thinking.js';
import { hasThinking } from '../replay/thinking.js';
import type { Element } from '../element.js';

/**
 * Screen furniture: the four beats of a decision, named. Each names a part of the
 * panel; none of them says anything about any event (RULE-54).
 */
export const THINKING_CAPTION = 'この手で Agent が考えたこと';
export const THINKING_HEADINGS = {
  read: '読み取ったこと',
  thought: '考えたこと',
  decided: '決めたこと',
  checks: '実行前に確かめたこと',
} as const;

export const THINKING_IDLE = '再生を押すと、その手で Agent が考えたことがここに出ます。';
export const THINKING_NONE = 'この手の内訳は残っていません。図に添えた説明が全部です。';

/** The four verdicts a check can carry, as the record spells them. */
const CHECK_MARKS: Readonly<Record<ActivityRecordCheck['result'], string>> = {
  passed: '通過',
  blocked: '不可',
  failed: '失敗',
  skipped: '未実施',
};

/**
 * What the agent was thinking on the step the picture is on.
 *
 * The diagram answers "what went where". This answers the question people actually
 * asked of it — 「AI エージェントがどういうことを考えて、どうするかを決めたのか」 — and it
 * answers it beside the picture, on the same step, while it moves. The words were
 * always in the record; they were folded away under the animation, in the same shape
 * as the request bodies, where nobody opened them.
 *
 * Every sentence in it is a `label`, a `message`, a `text` or a `value` the publisher
 * wrote. The panel supplies four headings and the marks beside the verdicts, and not
 * one sentence about what happened (RULE-54, REQ-11-002). The agent's own words are
 * set as a quotation for the same reason the record view sets them that way: so a
 * reader can tell what the model said from what the screen says.
 */
export function ThinkingPanel(props: { frame?: ThinkingFrame | null; taskKey?: string }): Element {
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
        : <ThinkingBody frame={frame} />}
    </aside>
  );
}

function ThinkingBody(props: { frame: ThinkingFrame }): Element {
  const frame = props.frame;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={frame.eventId}
        className="thinking-body"
        data-thinking-event={frame.eventId}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.25 }}
      >
        <p className="thinking-who" data-field="thinking-who">
          {frame.actor
            ? (
              <>
                <span className="thinking-actor">{frame.actor.label}</span>
                <span className="thinking-actor-role">{frame.actor.role}</span>
              </>
            )
            : <span className="thinking-actor">{frame.source}</span>}
          {frame.step === null ? null : <span className="thinking-step" data-field="thinking-step">{`${frame.step} 手目`}</span>}
        </p>
        {frame.headline === ''
          ? null
          : <p className="thinking-headline" data-field="thinking-headline">{frame.headline}</p>}

        <Beat name="read" blocks={frame.read} />
        <Beat name="thought" blocks={frame.thought} quoted />
        <Beat name="decided" blocks={frame.decided} />
        <Checks checks={frame.checks} />

        {hasThinking(frame)
          ? null
          : <p className="thinking-none" data-field="thinking-none">{THINKING_NONE}</p>}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * One beat of the story, and nothing when the publisher recorded none.
 *
 * An empty heading is worse than a missing one: it says there was a step here that was
 * left blank, when in fact this kind of event simply has no such part.
 */
function Beat(props: { name: keyof typeof THINKING_HEADINGS; blocks: readonly ThinkingBlock[]; quoted?: boolean }): Element {
  if (props.blocks.length === 0) return null;
  return (
    <section className="thinking-beat" data-beat={props.name}>
      <h5 className="thinking-beat-heading">{THINKING_HEADINGS[props.name]}</h5>
      {props.blocks.map((block, index) => (
        <motion.div
          key={block.id}
          className="thinking-block"
          data-block-id={block.id}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.05 * index, duration: 0.2 }}
        >
          <p className="thinking-label">{block.label}</p>
          {block.message === '' ? null : <p className="thinking-message">{block.message}</p>}
          {block.text === ''
            ? null
            : props.quoted
              ? <blockquote className="thinking-quote" data-field="thinking-quote">{block.text}</blockquote>
              : <pre className="thinking-text" data-text-format={block.format}>{block.text}</pre>}
          {block.fields.length === 0
            ? null
            : (
              <table className="thinking-fields">
                <tbody>
                  {block.fields.map((field, at) => (
                    <tr key={`${at}:${field.label}`}>
                      <th scope="row">{field.label}</th>
                      <td>{field.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </motion.div>
      ))}
    </section>
  );
}

/**
 * The checks, one after another rather than all at once.
 *
 * They are a sequence in the record and a sequence in reality — the tool is looked up,
 * then the lifetime, then the conditions — and a person watching the picture move has
 * time to read them arriving in that order. They are never behind a disclosure: they
 * are the answer to "did anything actually stop this".
 */
function Checks(props: { checks: readonly ActivityRecordCheck[] }): Element {
  if (props.checks.length === 0) return null;
  return (
    <section className="thinking-beat" data-beat="checks">
      <h5 className="thinking-beat-heading">{THINKING_HEADINGS.checks}</h5>
      <ul className="thinking-checks">
        {props.checks.map((check, index) => (
          <motion.li
            key={check.id}
            data-check-id={check.id}
            data-check-result={check.result}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.08 * index, duration: 0.2 }}
          >
            <span className="check-mark" data-check-mark={check.result}>{CHECK_MARKS[check.result]}</span>
            <span className="check-label">{check.label}</span>
            <span className="check-message">{check.message}</span>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}
