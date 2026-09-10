import { phaseLabelOf } from '../labels.js';
import type { Element } from '../element.js';

export function Metric(props: { label: string; value: string | number; tone?: string }): Element {
  return (
    <div className={`metric ${props.tone ?? ''}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}
export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date);
}
export function ResultMark(props: { outcome: string }): Element {
  const marks: Record<string, string> = { success: '✓', blocked: '!', failed: '×', running: '◷' };
  return (
    <span className="result-mark" data-outcome={props.outcome} aria-hidden="true">
      {marks[props.outcome] ?? '•'}
    </span>
  );
}

export function formatDuration(millis: number): string {
  if (!Number.isFinite(millis)) return '—';
  const seconds = Math.max(0, millis) / 1000;
  if (seconds < 1) return `${Math.round(Math.max(0, millis))} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}

/** The phase's caption, from the one dictionary the rows and the dots share. */
export function phaseLabel(phase: string): string {
  return phaseLabelOf(phase);
}

/** The four marks, spelled out once so a person learns them before the rows use them. */
export const MARK_LEGEND: ReadonlyArray<{ outcome: string; label: string }> = [
  { outcome: 'success', label: '成功' },
  { outcome: 'blocked', label: '遮断' },
  { outcome: 'failed', label: '失敗' },
  { outcome: 'running', label: '実行中' },
];

export function MarkLegend(): Element {
  return (
    <ul className="mark-legend" data-mark-legend="true" aria-label="記号の意味">
      {MARK_LEGEND.map((item) => (
        <li key={item.outcome}><ResultMark outcome={item.outcome} />{item.label}</li>
      ))}
    </ul>
  );
}
