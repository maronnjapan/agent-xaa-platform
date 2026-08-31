/**
 * DEC-IAC-16. One variable decides the lifetime of everything about an agent, so the
 * job timeout, the registration, the IdP connection and the grant cap cannot disagree.
 *
 * The human may ask for less than the ceiling; they may not ask for more.
 */
export function computeExpiresAt(input: {
  requestedLifetimeHours: number;
  agentMaxLifetimeSeconds: number;
  now: number;
}): { createdAt: string; expiresAt: string; lifetimeSeconds: number } {
  const requested = Math.max(1, Math.floor(input.requestedLifetimeHours)) * 3600;
  const lifetimeSeconds = Math.min(requested, input.agentMaxLifetimeSeconds);
  return {
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + lifetimeSeconds * 1000).toISOString(),
    lifetimeSeconds,
  };
}
