import type { Element } from '../element.js';

/**
 * One small glyph per phase, drawn inline.
 *
 * The seven phases are the seven kinds of thing that happen to a person's agent, and a
 * row that begins with a shape is found faster than a row that begins with a word — the
 * eye picks the wrench out of a column before it has read 「ツール実行」. The word is
 * still there, beside the glyph, on every row: the shape is a handle, never the only
 * statement of what the row is (RULE-54 for pictures).
 *
 * Inline rather than from an icon package: seven strokes are not worth a dependency,
 * and the bundle every screen loads should carry only what the screens draw.
 */
const PATHS: Readonly<Record<string, string>> = {
  login: 'M6.5 5.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9.5 8.5H15M13 8.5v2.5',
  work_definition: 'M3 13l1-4 7-7 3 3-7 7zM10 3l3 3',
  authorization: 'M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4zM5.8 8l1.6 1.6L10.5 6.5',
  provisioning: 'M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6',
  tool_call: 'M13.5 2.5a3 3 0 0 0-4 4L3 13l2 2 6.5-6.5a3 3 0 0 0 4-4l-2 2-2-2z',
  security: 'M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  lifecycle: 'M4 14V2h8l-2 3 2 3H4',
};

export function PhaseIcon(props: { phase: string; className?: string }): Element {
  const path = PATHS[props.phase];
  if (!path) return null;
  return (
    <svg
      className={props.className ? `phase-icon ${props.className}` : 'phase-icon'}
      data-phase-icon={props.phase}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
