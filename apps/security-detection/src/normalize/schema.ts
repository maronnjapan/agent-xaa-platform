export const SEVERITY_ID: Readonly<Record<string, number>> = {
  DEBUG: 1, INFO: 2, NOTICE: 3, WARNING: 4, ERROR: 5, CRITICAL: 6,
};

export interface NormalizedEvent {
  class_uid: number;
  activity_id: number;
  severity_id: number;
  time: string;
  actor: {
    actor_type: string;
    actor_id: string;
    on_behalf_of: string;
    human_subject: string | null;
    agent_id: string | null;
  };
  api: { operation: string; method: string; resource: string; status: string };
  metadata: {
    correlation_uid: string;
    trace_id: string;
    request_id: string;
    app: string;
    log_source: string;
  };
  attributes: Record<string, unknown>;
}

/**
 * The shape every log becomes before anything reasons about it.
 *
 * `attributes` is the one open map: each source has fields nobody else has, and forcing
 * them into a common vocabulary would either lose them or grow this schema forever.
 * Everything a rule or a correlation reads lives in the closed part above it.
 */
export const normalizedEventSchema = {
  $id: 'normalized-event',
  type: 'object',
  additionalProperties: false,
  required: ['class_uid', 'activity_id', 'severity_id', 'time', 'actor', 'api', 'metadata', 'attributes'],
  properties: {
    class_uid: { type: 'integer' },
    activity_id: { type: 'integer' },
    severity_id: { type: 'integer', minimum: 1, maximum: 6 },
    time: { type: 'string', format: 'date-time' },
    actor: {
      type: 'object', additionalProperties: false,
      required: ['actor_type', 'actor_id', 'on_behalf_of', 'human_subject', 'agent_id'],
      properties: {
        actor_type: { type: 'string' }, actor_id: { type: 'string' }, on_behalf_of: { type: 'string' },
        human_subject: { type: ['string', 'null'] }, agent_id: { type: ['string', 'null'] },
      },
    },
    api: {
      type: 'object', additionalProperties: false,
      required: ['operation', 'method', 'resource', 'status'],
      properties: {
        operation: { type: 'string' }, method: { type: 'string' },
        resource: { type: 'string' }, status: { type: 'string' },
      },
    },
    metadata: {
      type: 'object', additionalProperties: false,
      required: ['correlation_uid', 'trace_id', 'request_id', 'app', 'log_source'],
      properties: {
        correlation_uid: { type: 'string', minLength: 1 }, trace_id: { type: 'string' },
        request_id: { type: 'string' }, app: { type: 'string' }, log_source: { type: 'string' },
      },
    },
    attributes: { type: 'object' },
  },
} as const;
