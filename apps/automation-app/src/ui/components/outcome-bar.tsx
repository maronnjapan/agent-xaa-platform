import type { Element } from '../element.js';

export interface OutcomeCounts {
  success: number;
  blocked: number;
  failed: number;
  running?: number;
  info?: number;
}

const SEGMENTS: ReadonlyArray<{ key: keyof OutcomeCounts; label: string }> = [
  { key: 'success', label: '成功' },
  { key: 'blocked', label: '遮断' },
  { key: 'failed', label: '失敗' },
  { key: 'running', label: '実行中' },
  { key: 'info', label: '情報' },
];

/**
 * How a set of things ended, as one bar.
 *
 * Four tiles of numbers say how many; this says how much of the whole each is, which
 * is the question a person scanning a page actually has — 「だいたい通っているのか、
 * 止められてばかりなのか」. Every segment carries its label and count in text, so the
 * proportion is readable by someone who cannot tell the colours apart.
 */
export function OutcomeBar(props: { counts: OutcomeCounts; label: string }): Element {
  const total = SEGMENTS.reduce((sum, segment) => sum + (props.counts[segment.key] ?? 0), 0);
  if (total === 0) return null;
  return (
    <div className="outcome-bar" data-outcome-bar="true" role="img" aria-label={`${props.label}：${describe(props.counts)}`}>
      <div className="outcome-bar-track">
        {SEGMENTS.map((segment) => {
          const count = props.counts[segment.key] ?? 0;
          if (count === 0) return null;
          return (
            <span
              key={segment.key}
              className="outcome-bar-segment"
              data-outcome={segment.key}
              style={{ flexGrow: count }}
              title={`${segment.label} ${count}`}
            />
          );
        })}
      </div>
      <ul className="outcome-bar-legend">
        {SEGMENTS.map((segment) => {
          const count = props.counts[segment.key] ?? 0;
          if (count === 0) return null;
          return (
            <li key={segment.key} data-outcome={segment.key}>
              <span className="outcome-bar-swatch" aria-hidden="true" />
              {segment.label} <b>{count}</b>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function describe(counts: OutcomeCounts): string {
  return SEGMENTS
    .filter((segment) => (counts[segment.key] ?? 0) > 0)
    .map((segment) => `${segment.label} ${counts[segment.key]}`)
    .join('、');
}
