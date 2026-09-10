import { phaseLabelOf } from '../labels.js';
import type { Element } from '../element.js';

/** More dots than this and the strip says how many are left rather than drawing them. */
const SHAPE_LIMIT = 24;

const OUTCOME_TEXT: Readonly<Record<string, string>> = { success: '成功', blocked: '遮断', failed: '失敗', info: '情報' };

/**
 * The shape of a task: one dot per event, in order, coloured by how it ended.
 *
 * Twelve green dots and one amber one say where a task was stopped before its head
 * is read; the words in the badge still say it too. Each dot carries its phase and
 * outcome as text for anyone who cannot see it, and the colours are the same four
 * hues the badges use (emphasis.css), so a green dot and a green badge say one thing.
 */
export function TaskShape(props: { shape: ReadonlyArray<{ phase: string; outcome: string }> }): Element {
  if (props.shape.length === 0) return null;
  const shown = props.shape.slice(0, SHAPE_LIMIT);
  const rest = props.shape.length - shown.length;
  return (
    <span className="task-shape" data-task-shape="true" role="img" aria-label={`${props.shape.length} 件の記録`}>
      {shown.map((dot, index) => (
        <span
          key={index}
          className="shape-dot"
          data-outcome={dot.outcome}
          data-phase={dot.phase}
          title={`${index + 1}. ${phaseLabelOf(dot.phase)} · ${OUTCOME_TEXT[dot.outcome] ?? dot.outcome}`}
        />
      ))}
      {rest > 0 ? <span className="shape-more">+{rest}</span> : null}
    </span>
  );
}
