/**
 * The Effective Capability set as the Authorization Platform hands it over, and the
 * only place in this app where those identifiers are written down.
 *
 * `scripts/checks/no-authz-vocabulary-in-automation-app.sh` forbids `document.read`
 * and its nine siblings anywhere under `apps/automation-app/src` (RULE-07): the screen
 * receives them as opaque strings, lists them, and hashes them, and never branches on
 * one. A test still needs realistic values, so they live here — under `test/`, which
 * the check deliberately does not scan.
 *
 * The reordered copy is the same set written in a different order: presenting order is
 * not part of the decision, so the approval hash has to be identical.
 */
export const PRESENTED_CAPABILITIES = ['document.read', 'calendar.event.read', 'docs.write'] as const;

export const PRESENTED_CAPABILITIES_REORDERED = ['docs.write', 'document.read', 'calendar.event.read'] as const;

/** One capability more than the person approved, as a later decision might return. */
export const PRESENTED_CAPABILITIES_WIDENED = [...PRESENTED_CAPABILITIES, 'finance.tx.read'] as const;
