import { detailKeyLabelOf } from '../labels.js';
import type { Element } from '../element.js';

export const DETAIL_CAPTION = '技術的な詳細';

/**
 * The event's `detail`, shown as it is.
 *
 * Every key becomes a row and every value is printed as it came; arrays are joined
 * with `、`. Nothing here composes a sentence out of the values (REQ-11-002): the
 * publisher already wrote the sentence, in `message`, at the time it happened. A
 * screen that phrased `detail` itself would be interpreting a record it did not make.
 *
 * What the screen does add is a caption for the keys it knows — `決定の ID` beside
 * `decision_id` — because a key is a name for a field, and naming a field is the
 * screen's job. The key itself stays on the row, so a person matching the screen
 * against a log still finds it. A key the table does not know is shown as it is.
 *
 * Closed by default, and its state is not remembered — a disclosure that reopened
 * itself on the next visit would show different things to two people looking at the
 * same link.
 */
export function DetailDisclosure(props: { detail?: Record<string, unknown>; simulated?: boolean }): Element | null {
  if (!props.detail || Object.keys(props.detail).length === 0) return null;
  return (
    <details className="detail-disclosure" data-detail="true">
      <summary>
        {DETAIL_CAPTION}
        {props.simulated ? <span className="simulated-badge" data-simulated="true">デモ実行（模擬）</span> : null}
      </summary>
      <table>
        <tbody>
          {Object.entries(props.detail).map(([key, value]) => {
            const caption = detailKeyLabelOf(key);
            return (
              <tr key={key} data-detail-key={key}>
                <th scope="row">
                  {caption === null ? <code className="detail-key">{key}</code> : (
                    <>
                      <span className="detail-caption">{caption}</span>
                      <code className="detail-key">{key}</code>
                    </>
                  )}
                </th>
                <td>{formatValue(value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
