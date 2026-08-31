export class EffectiveExceedsHumanPermissionError extends Error {
  constructor(readonly exceeded: string[]) {
    // The message names only what escaped, never the whole permission set: an error
    // string is a poor place to publish someone's full entitlements.
    super(`effective capabilities exceed the human permission set: ${exceeded.join(', ')}`);
    this.name = 'EffectiveExceedsHumanPermissionError';
  }
}

/**
 * RULE-11's invariant, checked at run time rather than trusted.
 *
 * An agent can never hold a capability its delegating human does not. The set
 * algebra already guarantees it; this assertion exists so a future edit that breaks
 * the algebra fails loudly instead of quietly widening an agent's reach.
 */
export function assertEffectiveSubsetOfHuman(effective: string[], human: string[]): void {
  const held = new Set(human);
  const exceeded = effective.filter((capability) => !held.has(capability));
  if (exceeded.length > 0) throw new EffectiveExceedsHumanPermissionError(exceeded);
}
