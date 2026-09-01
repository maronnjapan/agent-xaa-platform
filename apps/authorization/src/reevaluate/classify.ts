export type PermissionChangeKind = 'unchanged' | 'shrunk' | 'expanded' | 'mixed';

/**
 * REQ-07-028. How a re-evaluation's new Effective Capability set relates to the old
 * one, decided by set inclusion alone: order and duplicates say nothing about
 * authority, so they must not change the answer.
 *
 * The four names are not symmetric in what they cause. A narrowing has to reach the
 * running agent, because it holds authority it should no longer have; a widening must
 * not, because an agent's authority is fixed at provisioning (RULE-13, RULE-14). A
 * `mixed` change contains a narrowing, so it is treated as one.
 */
export function classifyChange(oldSet: readonly string[], newSet: readonly string[]): PermissionChangeKind {
  const before = new Set(oldSet);
  const after = new Set(newSet);
  const removed = [...before].some((capability) => !after.has(capability));
  const added = [...after].some((capability) => !before.has(capability));
  if (removed && added) return 'mixed';
  if (removed) return 'shrunk';
  if (added) return 'expanded';
  return 'unchanged';
}

/**
 * What a narrowing hands to Re-Provisioning: everything the new decision allows that
 * the old agent already had. The added half of a `mixed` change is dropped here rather
 * than at the call site, so no path can widen an agent by way of a narrowing.
 */
export function retainedCapabilities(oldSet: readonly string[], newSet: readonly string[]): string[] {
  const before = new Set(oldSet);
  return [...new Set(newSet)].filter((capability) => before.has(capability)).sort();
}
