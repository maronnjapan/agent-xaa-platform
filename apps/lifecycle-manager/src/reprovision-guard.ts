import { isValidCapabilityId } from '@xaa/contracts';

export class CapabilityInsufficientError extends Error {
  readonly code = 'capability_insufficient';
  constructor(readonly missing_capabilities: string[]) {
    super(`capability_insufficient: ${missing_capabilities.join(', ')}`);
  }
}

/**
 * Can the work still be done with what the person still has?
 *
 * Exact string equality, with no prefix or wildcard interpretation: `document.readonly`
 * is not `document.read`, and treating it as a match would silently re-provision an
 * agent with a permission nobody granted.
 *
 * What is filtered out first is anything that is not a capability id at all, such as
 * `document.`. The check is on the shape rather than on the eight ids the platform
 * ships with, because an administrator can add a capability to the taxonomy and this
 * app never reads that table — a fixed list here would report a permission the person
 * genuinely holds as missing, and refuse to re-provision an agent that should survive.
 *
 * Every missing capability is reported, not just the first — the person needs to know
 * what it would take to make this work, not one item at a time.
 */
export function assertCapabilitiesSufficient(required: readonly string[], granted: readonly string[]): void {
  const held = new Set(granted.filter((capability) => isValidCapabilityId(capability)));
  const missing = required.filter((capability) => !held.has(capability));
  if (missing.length > 0) throw new CapabilityInsufficientError(missing);
}
