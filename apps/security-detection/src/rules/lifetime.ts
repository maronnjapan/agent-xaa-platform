import type { RuleContext } from './context.js';
import { hitFromEvent, withAgent } from './hit.js';
import type { RuleHit } from './types.js';

/** Only these two sources carry an age and an expiry; the rest never did (RULE-41). */
export const LIFETIME_SOURCES: readonly string[] = ['agent_runtime', 'resource_api'];

/**
 * REQ-09-033. An agent that outlived the ceiling, and one that worked past its expiry.
 *
 * Both numbers come out of the log line the Runtime wrote at the moment of the call —
 * `agent_age_seconds` and `expires_at` — and neither is recomputed here. The Cloud Run
 * revision's start time and the container's uptime describe the process, not the agent;
 * a redeployed revision would reset an age the agent itself never lost.
 *
 * The ceiling is `AGENT_MAX_LIFETIME_SECONDS` and nothing else. Writing 86400 here would
 * be a second answer to a question DEC-IAC-16 already settled, and the verification
 * profile that lowers it to 3600 would stop being verifiable.
 *
 * An event with neither field is skipped rather than flagged: the eight other log sources
 * have never carried them, and treating their absence as a violation would make every
 * Agent OP line a lifetime finding.
 */
export function detectLifetimeHits(context: RuleContext): RuleHit[] {
  const hits: RuleHit[] = [];

  for (const event of withAgent(context.events)) {
    if (!LIFETIME_SOURCES.includes(event.metadata.log_source)) continue;

    const age = event.attributes.agent_age_seconds;
    if (context.maxLifetimeSeconds !== null && typeof age === 'number' && Number.isFinite(age)
      && age > context.maxLifetimeSeconds) {
      hits.push(hitFromEvent({
        ruleId: 'lifetime.age_exceeded', category: 'lifetime', level: 'HIGH', event,
        detail: { observed: age, expected: context.maxLifetimeSeconds },
      }));
    }

    const expiresAt = event.attributes.expires_at;
    if (typeof expiresAt === 'string' && expiresAt !== '') {
      // Both sides through epoch milliseconds: the two strings come from different
      // services and only their instants are comparable.
      const expiry = Date.parse(expiresAt);
      const at = Date.parse(event.time);
      if (Number.isFinite(expiry) && Number.isFinite(at) && at > expiry) {
        hits.push(hitFromEvent({
          ruleId: 'lifetime.access_after_expiry', category: 'lifetime', level: 'HIGH', event,
          detail: { observed: event.time, expected: expiresAt },
        }));
      }
    }
  }
  return hits;
}
