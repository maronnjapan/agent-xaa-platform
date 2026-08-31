export const AGENT_STATUSES = [
  'CREATED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'EXPIRED',
  'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED',
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export class InvalidTransitionError extends Error {
  readonly code = 'invalid_transition';
  constructor(readonly from: AgentStatus, readonly to: AgentStatus) {
    super(`invalid_transition: ${from} -> ${to}`);
  }
}

/**
 * The eleven ways an agent's state may change (docs 07 §2).
 *
 * Written as a table rather than as conditions so the whole life of an agent is
 * readable in one place — and so that everything absent from it is impossible.
 * There is no path back from QUARANTINED, REVOKED or DESTROYED: an agent that was
 * stopped is not restarted, it is replaced.
 */
export const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [AgentStatus, AgentStatus]> = [
  ['CREATED', 'PROVISIONING'],
  ['PROVISIONING', 'ACTIVE'],
  ['PROVISIONING', 'REVOKED'],
  ['ACTIVE', 'EXPIRING'],
  ['EXPIRING', 'EXPIRED'],
  ['EXPIRED', 'REVOKED'],
  ['ACTIVE', 'SUSPICIOUS'],
  ['SUSPICIOUS', 'QUARANTINED'],
  ['QUARANTINED', 'REVOKED'],
  ['ACTIVE', 'REVOKED'],
  ['REVOKED', 'DESTROYED'],
];

/**
 * ACTIVE straight to QUARANTINED, only on a CRITICAL finding.
 *
 * It is kept out of the table on purpose. Ordinarily an agent passes through
 * SUSPICIOUS first, which gives a person a chance to look; a CRITICAL finding cannot
 * wait for that. Making the exception explicit — an argument the caller must pass —
 * means nothing reaches it by accident.
 */
export function transition(
  from: AgentStatus,
  to: AgentStatus,
  options: { severity?: 'CRITICAL' } = {},
): AgentStatus {
  if (from === to) throw new InvalidTransitionError(from, to);
  if (from === 'ACTIVE' && to === 'QUARANTINED') {
    if (options.severity !== 'CRITICAL') throw new InvalidTransitionError(from, to);
    return to;
  }
  if (!ALLOWED_TRANSITIONS.some(([start, end]) => start === from && end === to)) {
    throw new InvalidTransitionError(from, to);
  }
  return to;
}
