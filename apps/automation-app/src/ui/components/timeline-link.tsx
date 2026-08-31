import type { Element } from '../element.js';

export const TIMELINE_NOTE = '完了した処理だけを再生します。実行中の処理は状況確認で見てください。';

/**
 * A separate section, with the caveat always visible.
 *
 * The note is not inside a disclosure and not a tooltip: someone who clicks through to
 * the timeline and finds their running task missing needs to have been told why
 * beforehand, not after. The link carries no count either — a number here would
 * suggest the timeline knows about work it deliberately does not show (RULE-59).
 */
export function TimelineLink(props: { agentId: string }): Element {
  return (
    <section data-section="timeline-link" class="timeline-link">
      <h2>タイムライン</h2>
      <a href={`/activity?agent_id=${encodeURIComponent(props.agentId)}`}>この Agent の記録を見る</a>
      <p class="timeline-note">{TIMELINE_NOTE}</p>
    </section>
  );
}
