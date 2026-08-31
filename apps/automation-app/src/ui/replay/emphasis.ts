export const EMPHASIS_CLASSES = ['ev-info', 'ev-success', 'ev-blocked-tool', 'ev-blocked-security'] as const;
export type EmphasisClass = (typeof EMPHASIS_CLASSES)[number];

export const EMPHASIS_LABELS: Readonly<Record<EmphasisClass, string>> = {
  'ev-info': '情報',
  'ev-success': '成功',
  'ev-blocked-tool': '遮断',
  'ev-blocked-security': '遮断（セキュリティ）',
};

/**
 * How strongly to draw a row, from two values and nothing else.
 *
 * A blocked tool call is ordinary: an agent asked for something outside its
 * permissions and the platform said no. A blocked security event is not — it means a
 * detection rule fired. Drawing them the same way would train people to ignore both
 * (RULE-54), so the security one gets its own class, a heavier border and an icon.
 *
 * The function never looks at the event type. Names change; `outcome` and `phase` are
 * the two fields the schema pins.
 */
export function emphasisClass(outcome: string, phase: string): EmphasisClass {
  if (outcome === 'blocked') return phase === 'security' ? 'ev-blocked-security' : 'ev-blocked-tool';
  if (outcome === 'success') return 'ev-success';
  return 'ev-info';
}
