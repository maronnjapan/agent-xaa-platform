import { compile } from '@xaa/contracts';
import type { LogEntry, LogSource } from '@xaa/logging';
import { CLASS_UID, UNMAPPED_CLASS_UID, isKnownSource } from './class-uid.js';
import { normalizedEventSchema, SEVERITY_ID, type NormalizedEvent } from './schema.js';
import { convert as humanIdp } from './converters/human-idp.js';
import { convert as authzAi } from './converters/authz-ai.js';
import { convert as policyEngine } from './converters/policy-engine.js';
import { convert as provisioner } from './converters/provisioner.js';
import { convert as agentOp } from './converters/agent-op.js';
import { convert as agentOpIdpConnection } from './converters/agent-op-idp-connection.js';
import { convert as googleBridge } from './converters/google-bridge.js';
import { convert as nativeResourceAs } from './converters/native-resource-as.js';
import { convert as resourceApi } from './converters/resource-api.js';
import { convert as agentRuntime } from './converters/agent-runtime.js';

export type { NormalizedEvent };
export { normalizedEventSchema, CLASS_UID, UNMAPPED_CLASS_UID };

/** A record, not a switch: adding a source is adding a key, and the type checks it. */
const CONVERTERS: Readonly<Record<LogSource, (entry: LogEntry) => NormalizedEvent>> = {
  human_idp: humanIdp,
  authz_ai: authzAi,
  policy_engine: policyEngine,
  provisioner,
  agent_op: agentOp,
  agent_op_idp_connection: agentOpIdpConnection,
  google_bridge: googleBridge,
  native_resource_as: nativeResourceAs,
  resource_api: resourceApi,
  agent_runtime: agentRuntime,
};

export interface NormalizeCounters {
  schema_violation_total: number;
  unmapped_source_total: number;
}

export interface NormalizeResult {
  events: NormalizedEvent[];
  /** Stored for the record, but not passed on: nothing downstream knows their shape. */
  unmapped: NormalizedEvent[];
  counters: NormalizeCounters;
}

const assertEvent: (value: unknown) => asserts value is NormalizedEvent =
  compile<NormalizedEvent>(normalizedEventSchema);

const REQUIRED_KEYS = ['human_subject', 'agent_id', 'trace_id', 'timestamp'] as const;

/**
 * Turns each application's own log shape into the one the rules read.
 *
 * A missing *key* is a violation; a `null` value is not. The distinction matters: an
 * event with `agent_id: null` is a human acting, which is ordinary, while an event with
 * no `agent_id` key at all came from something that is not using the shared logger — and
 * whatever else it is, it cannot be correlated.
 *
 * Sources this pipeline does not model (the Automation App, the Lifecycle Manager) are
 * kept rather than dropped, under one class id, and go no further. Their logs are worth
 * having; inventing a detection story for them is not.
 */
export function normalizeEntries(entries: readonly unknown[]): NormalizeResult {
  const events: NormalizedEvent[] = [];
  const unmapped: NormalizedEvent[] = [];
  const counters: NormalizeCounters = { schema_violation_total: 0, unmapped_source_total: 0 };

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') { counters.schema_violation_total += 1; continue; }
    const entry = raw as Record<string, unknown>;
    if (REQUIRED_KEYS.some((key) => !(key in entry))) { counters.schema_violation_total += 1; continue; }

    const source = entry.log_source;
    if (!isKnownSource(source)) {
      counters.unmapped_source_total += 1;
      unmapped.push(minimal(entry));
      continue;
    }
    const event = CONVERTERS[source](entry as unknown as LogEntry);
    if (event.metadata.correlation_uid === '') { counters.schema_violation_total += 1; continue; }
    try {
      assertEvent(event);
    } catch {
      counters.schema_violation_total += 1;
      continue;
    }
    events.push(event);
  }
  return { events, unmapped, counters };
}

function minimal(entry: Record<string, unknown>): NormalizedEvent {
  return {
    class_uid: UNMAPPED_CLASS_UID,
    activity_id: 0,
    severity_id: SEVERITY_ID[String(entry.severity)] ?? 2,
    time: String(entry.timestamp ?? new Date().toISOString()),
    actor: {
      actor_type: 'unknown', actor_id: '', on_behalf_of: '',
      human_subject: (entry.human_subject as string | null) ?? null,
      agent_id: (entry.agent_id as string | null) ?? null,
    },
    api: { operation: String(entry.event ?? ''), method: '', resource: '', status: '' },
    metadata: {
      correlation_uid: String(entry.trace_id || entry.request_id || 'unmapped'),
      trace_id: String(entry.trace_id ?? ''), request_id: String(entry.request_id ?? ''),
      app: String(entry.app ?? ''), log_source: String(entry.log_source ?? ''),
    },
    attributes: {},
  };
}
