import { CAPABILITIES } from '@xaa/contracts';

export class CapabilityInsufficientError extends Error {
  readonly code = 'capability_insufficient';
  constructor(readonly missing_capabilities: string[]) {
    super(`capability_insufficient: ${missing_capabilities.join(', ')}`);
  }
}

/**
 * Can the work still be done with what the person still has?
 *
 * Exact string equality against the eight known capability ids, with no prefix or
 * wildcard interpretation: `document.readonly` is not `document.read`, and treating it
 * as a match would silently re-provision an agent with a permission nobody granted.
 *
 * Every missing capability is reported, not just the first — the person needs to know
 * what it would take to make this work, not one item at a time.
 */
export function assertCapabilitiesSufficient(required: readonly string[], granted: readonly string[]): void {
  const known = new Set<string>(CAPABILITIES);
  const held = new Set(granted.filter((capability) => known.has(capability)));
  const missing = required.filter((capability) => !held.has(capability));
  if (missing.length > 0) throw new CapabilityInsufficientError(missing);
}
