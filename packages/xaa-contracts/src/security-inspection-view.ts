import type { FromSchema } from 'json-schema-to-ts';
import { compile } from './schema/validator.js';

/**
 * The mechanical half of docs 09 §5, as a person is shown it.
 *
 * A Security Finding exists only where something tripped. That leaves the ordinary case
 * — an agent whose logs were read and whose every mechanical pass came back clean —
 * indistinguishable, on the screen, from an agent whose logs never arrived. Both render
 * as an empty page, and 「まだ何も記録していません」 is then read as 「見ていない」.
 *
 * This is the record that separates them: for one agent and one window, which passes ran
 * over its logs, how many lines they read, and which codes came back. It carries no
 * verdict and no score. It is not a finding and must never be shown as one — a clean
 * window is not a weak alarm, and the two would be confused the moment they shared a row.
 *
 * Like `SecurityFindingView` it is deliberately not the stored document: correlation ids
 * and trace ids stay on the detector's side of the wire (RULE-38).
 */
export const SECURITY_INSPECTION_CHECKS = [
  'protocol_validation', 'token_rate', 'authorization', 'tool',
  'lifetime', 'isolation', 'authorization_ai', 'baseline_deviation',
] as const;
export type SecurityInspectionCheck = (typeof SECURITY_INSPECTION_CHECKS)[number];

export const securityInspectionViewSchema = {
  $id: 'security-inspection-view',
  type: 'object',
  additionalProperties: false,
  required: [
    'inspection_id', 'agent_id', 'human_subject', 'window_start', 'window_end',
    'events_examined', 'checks_run', 'checks_skipped', 'codes_raised', 'last_seen_at',
  ],
  properties: {
    inspection_id: { type: 'string', minLength: 1 },
    agent_id: { type: 'string', minLength: 1 },
    human_subject: { type: 'string' },
    window_start: { type: 'string' },
    window_end: { type: 'string' },
    /** How many normalised log lines for this agent the passes below actually read. */
    events_examined: { type: 'integer', minimum: 0 },
    checks_run: { type: 'array', items: { enum: SECURITY_INSPECTION_CHECKS } },
    /**
     * A pass that could not run, and why it could not is always the same why: the
     * classifications that measure an agent against its own baseline are silent when the
     * detector could not read one (see `rules/index.ts`). Naming them is the difference
     * between 「見て、何もなかった」 and 「そもそも見ていない」, which is the whole point
     * of this record.
     */
    checks_skipped: { type: 'array', items: { enum: SECURITY_INSPECTION_CHECKS } },
    /** The codes those passes raised in this window; empty when everything was clean. */
    codes_raised: { type: 'array', items: { type: 'string' } },
    last_seen_at: { type: 'string' },
  },
} as const;

export type SecurityInspectionView = FromSchema<typeof securityInspectionViewSchema>;

export const assertSecurityInspectionView: (value: unknown) => asserts value is SecurityInspectionView =
  compile<SecurityInspectionView>(securityInspectionViewSchema);
