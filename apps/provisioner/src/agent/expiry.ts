/**
 * The 24-hour cap, written here as well as in Terraform's validation, because a
 * deployment is not the only way an environment variable gets set: an operator who
 * exports AGENT_MAX_LIFETIME_SECONDS by hand must not be able to mint an agent that
 * outlives the day it was made.
 */
export const HARD_CAP_SECONDS = 86_400;

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
  const lifetimeSeconds = Math.min(requested, input.agentMaxLifetimeSeconds, HARD_CAP_SECONDS);
  return {
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + lifetimeSeconds * 1000).toISOString(),
    lifetimeSeconds,
  };
}

/**
 * The expiry a replacement agent inherits (T-PROV-16). It is copied, never
 * recomputed: recalculating it would let a permission change extend an agent's life,
 * and someone could keep one alive indefinitely by adjusting their own permissions.
 */
export function inheritExpiresAt(input: { inheritedExpiresAt: string; now: number }): {
  createdAt: string; expiresAt: string; lifetimeSeconds: number;
} | undefined {
  const remaining = Date.parse(input.inheritedExpiresAt) - input.now;
  if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
  return {
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.inheritedExpiresAt).toISOString(),
    lifetimeSeconds: Math.min(Math.ceil(remaining / 1000), HARD_CAP_SECONDS),
  };
}
