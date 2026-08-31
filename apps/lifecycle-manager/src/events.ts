import { publishActivityEvent, type ActivityEvent } from '@xaa/contracts';
import type { CleanupReason } from './config.js';
import { LIFECYCLE_MESSAGES } from './messages.js';

export type LifecycleEventType = 'AGENT_EXPIRED' | 'RE_PROVISIONED' | 'AGENT_REVOKED_SECURITY' | 'AGENT_REPROVISION_FAILED';

/**
 * Which reason produces which event — and which produces none.
 *
 * `USER_STOP` is absent on purpose: the Automation App already publishes
 * `AGENT_STOPPED` when the person presses the button, and a second event from here
 * would put the same action on their timeline twice. `REPROVISION` is also absent,
 * because the interesting moment is when the *new* agent exists, which cleanup cannot
 * know about.
 */
export function eventTypeFor(reason: CleanupReason): LifecycleEventType | null {
  if (reason === 'EXPIRED') return 'AGENT_EXPIRED';
  if (reason === 'QUARANTINE' || reason === 'IDENTITY_DISABLED') return 'AGENT_REVOKED_SECURITY';
  return null;
}

const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * One lifecycle event per agent, emitted once cleanup has actually finished.
 *
 * The `event_id` is derived from the agent and the event type rather than random, so a
 * retried cleanup produces the same id — and the Automation App's `create`-only write
 * turns the duplicate into a no-op. That is what keeps RULE-59's "one terminal event"
 * true across retries without this service having to remember anything.
 */
export async function emitLifecycleEvent(input: {
  eventType: LifecycleEventType;
  agentId: string;
  humanSubject: string;
  traceId: string;
  occurredAt?: string;
  findingId?: string | null;
  detail?: Record<string, unknown>;
  publish?: (event: ActivityEvent) => Promise<void>;
}): Promise<void> {
  const wording = LIFECYCLE_MESSAGES[input.eventType];
  const event: ActivityEvent = {
    event_id: `evt-${input.agentId}-${input.eventType}`,
    trace_id: input.traceId,
    human_subject: input.humanSubject,
    agent_id: input.agentId,
    task_id: 'lifecycle',
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    source: 'lifecycle-manager',
    phase: 'lifecycle',
    outcome: wording.outcome,
    title: wording.title,
    message: wording.message,
    detail: sanitize({ event_type: input.eventType, ...input.detail }) as Record<string, unknown>,
    related_finding_id: input.findingId ?? null,
    is_simulated: false,
  };
  await (input.publish ?? publishActivityEvent)(event);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof value === 'string') return JWT_SHAPE.test(value) ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/refresh_token|client_secret|private_key/i.test(key)) continue;
      output[key] = sanitize(item, depth + 1);
    }
    return output;
  }
  return value;
}
