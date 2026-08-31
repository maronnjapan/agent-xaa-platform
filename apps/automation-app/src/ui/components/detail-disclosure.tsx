import type { Element } from '../element.js';

/**
 * The event's `detail`, shown as it is.
 *
 * Keys become row headings verbatim and arrays are joined with `、`. Nothing here
 * composes a sentence out of the values (REQ-11-002): the publisher already wrote the
 * sentence, in `message`, at the time it happened. A screen that phrased `detail`
 * itself would be interpreting a record it did not make.
 *
 * Closed by default, and its state is not remembered — a disclosure that reopened
 * itself on the next visit would show different things to two people looking at the
 * same link.
 */
export function DetailDisclosure(props: { detail?: Record<string, unknown>; simulated?: boolean }): Element | null {
  if (!props.detail || Object.keys(props.detail).length === 0) return null;
  return (
    <details class="detail-disclosure" data-detail="true">
      <summary>
        詳細
        {props.simulated ? <span class="simulated-badge" data-simulated="true">デモ実行（模擬）</span> : null}
      </summary>
      <table>
        <tbody>
          {Object.entries(props.detail).map(([key, value]) => (
            <tr data-detail-key={key}>
              <th scope="row">{key}</th>
              <td>{formatValue(value)}</td>
            </tr>
          ))}
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
