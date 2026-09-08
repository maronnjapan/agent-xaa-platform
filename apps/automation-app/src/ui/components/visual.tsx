import type { Element } from '../element.js';

export function Metric(props: { label: string; value: string | number; tone?: string }): Element {
  return (
    <div class={`metric ${props.tone ?? ''}`}>
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
    <span class="result-mark" data-outcome={props.outcome} aria-hidden="true">
      {marks[props.outcome] ?? '•'}
    </span>
  );
}
