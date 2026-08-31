import { IdJagError } from '@maronn-openid-connect/experimental/id-jag';
import type { AgentRegistration } from '../store/types.js';

/** Never widened by configuration: a stale registration must not outlive 10 seconds. */
export const REGISTRATION_CACHE_TTL_SECONDS = 10;

const ISSUABLE_STATUSES = new Set(['ACTIVE', 'EXPIRING']);

/**
 * REQ-05-072 / REQ-07-016 / REQ-09-048. Evaluated on every exchange and every
 * subject-token reissue, with no leeway: the clock is the injected one, never
 * Date.now() read inline.
 *
 * REVOKED, EXPIRED and QUARANTINED all collapse to invalid_grant so a caller cannot
 * tell a quarantined agent from an expired one. Tokens already issued are not
 * revoked here; that is Lifecycle Cleanup's job.
 */
export function verifyAgentState(registration: AgentRegistration, now: Date): void {
  if (Date.parse(registration.expires_at) <= now.getTime()) {
    throw new IdJagError('invalid_grant', 'The agent is no longer eligible');
  }
  if (!ISSUABLE_STATUSES.has(registration.status)) {
    throw new IdJagError('invalid_grant', 'The agent is no longer eligible');
  }
}

export function agentExpiryCheck(registration: AgentRegistration, now: Date): 'ok' | 'expired' | 'not_active' {
  if (Date.parse(registration.expires_at) <= now.getTime()) return 'expired';
  return ISSUABLE_STATUSES.has(registration.status) ? 'ok' : 'not_active';
}
