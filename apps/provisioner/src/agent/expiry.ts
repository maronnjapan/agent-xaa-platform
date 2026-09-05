/**
 * The 24-hour cap, written here as well as in Terraform's validation, because a
 * deployment is not the only way an environment variable gets set: an operator who
 * exports AGENT_MAX_LIFETIME_SECONDS by hand must not be able to mint an agent that
 * outlives the day it was made.
 */
export const HARD_CAP_SECONDS = 86_400;

/**
 * RFC 3339 in UTC, to the second.
 *
 * The same string is compared in four places — the registration, the IdP connection,
 * the job environment and the completion log — and second precision is the coarsest
 * any of them has. Carrying milliseconds would make two values that mean the same
 * instant differ as strings, and the comparison is a string comparison.
 */
export function toRfc3339Seconds(epochMillis: number): string {
  return `${new Date(Math.floor(epochMillis / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

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
    createdAt: toRfc3339Seconds(input.now),
    expiresAt: toRfc3339Seconds(Math.floor(input.now / 1000) * 1000 + lifetimeSeconds * 1000),
    lifetimeSeconds,
  };
}

/**
 * The expiry an agent carries over rather than earns: a replacement for one whose
 * permissions changed (T-PROV-16), and the second half of a provisioning that paused
 * for a consent (T-PROV-17). It is copied, never recomputed — recalculating it would
 * let a permission change extend an agent's life, and would hand a consented agent
 * however long its owner spent on the consent screen.
 *
 * To the second, like a fresh expiry: this string is compared as a string where the
 * registration, the IdP connection and the job environment meet, so a copy that
 * carried milliseconds would differ from the connection the first half already wrote
 * for the same instant. Flooring can only shorten a life, never lengthen one.
 */
export function inheritExpiresAt(input: { inheritedExpiresAt: string; now: number }): {
  createdAt: string; expiresAt: string; lifetimeSeconds: number;
} | undefined {
  const inherited = Date.parse(input.inheritedExpiresAt);
  if (!Number.isFinite(inherited) || inherited - input.now <= 0) return undefined;
  const expiresAt = toRfc3339Seconds(inherited);
  const remaining = Date.parse(expiresAt) - input.now;
  return {
    createdAt: toRfc3339Seconds(input.now),
    expiresAt,
    // At least a second: a job given a timeout of zero is refused outright, which is a
    // worse answer than an agent that expires almost immediately.
    lifetimeSeconds: Math.max(1, Math.min(Math.ceil(remaining / 1000), HARD_CAP_SECONDS)),
  };
}
