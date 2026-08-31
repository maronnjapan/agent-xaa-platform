import type { LogEntry } from '@xaa/logging';
import { CLASS_UID } from '../class-uid.js';
import { SEVERITY_ID, type NormalizedEvent } from '../schema.js';

/** resource_api: docs 09 §2. */
export function convert(entry: LogEntry): NormalizedEvent {
  const fields = entry.fields;
  return {
    class_uid: CLASS_UID.resource_api,
    activity_id: 9,
    severity_id: SEVERITY_ID[entry.severity] ?? 2,
    time: entry.timestamp,
    actor: {
      actor_type: String(fields.actor_type ?? (entry.agent_id ? 'agent' : 'human')),
      actor_id: String(fields.actor_id ?? entry.agent_id ?? entry.human_subject ?? ''),
      on_behalf_of: String(fields.on_behalf_of ?? entry.human_subject ?? ''),
      human_subject: entry.human_subject,
      agent_id: entry.agent_id,
    },
    api: {
      operation: String(fields.tool_id ?? entry.event),
      method: String(fields.method ?? 'GET'),
      resource: String(fields.resource ?? ''),
      status: String(fields.status ?? entry.severity),
    },
    metadata: {
      correlation_uid: entry.trace_id || entry.request_id,
      trace_id: entry.trace_id,
      request_id: entry.request_id,
      app: entry.app,
      log_source: entry.log_source,
    },
    attributes: fields,
  };
}
