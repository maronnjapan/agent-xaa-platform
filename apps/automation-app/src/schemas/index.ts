import { activityRecordSchema } from '@xaa/contracts';

/** JSON Schemas the Automation App validates against, kept together (DEC-APP-05). */

export const suggestionSchema = {
  $id: 'automation-suggestion',
  type: 'object',
  additionalProperties: false,
  required: ['candidate_id', 'purpose', 'description', 'operations', 'user_confirmations', 'safety_notes'],
  properties: {
    candidate_id: { type: 'string', minLength: 1 },
    purpose: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    operations: { type: 'array', items: { type: 'string' } },
    user_confirmations: { type: 'array', items: { type: 'string' } },
    safety_notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const suggestionListSchema = {
  $id: 'automation-suggestion-list',
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: { suggestions: { type: 'array', items: suggestionSchema } },
} as const;

export const dailyReportSchema = {
  $id: 'daily-report',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: { title: { type: 'string', minLength: 1 }, body: { type: 'string', minLength: 1 } },
} as const;

export const WORK_DEFINITION_FIELDS = [
  'work_definition_id', 'human_subject', 'status', 'purpose', 'description', 'operations',
  'user_confirmations', 'safety_notes', 'requested_lifetime_hours', 'created_at', 'updated_at',
] as const;

export const workDefinitionSchema = {
  $id: 'work-definition',
  type: 'object',
  additionalProperties: false,
  required: [...WORK_DEFINITION_FIELDS],
  properties: {
    work_definition_id: { type: 'string', minLength: 1 },
    human_subject: { type: 'string', minLength: 1 },
    status: { enum: ['DRAFT', 'CONFIRMED'] },
    purpose: { type: 'string' },
    description: { type: 'string' },
    operations: { type: 'array', items: { type: 'string' } },
    user_confirmations: { type: 'array', items: { type: 'string' } },
    safety_notes: { type: 'array', items: { type: 'string' } },
    requested_lifetime_hours: { type: 'integer', minimum: 1, maximum: 24 },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * What one turn of the design conversation may rewrite.
 *
 * `status` is not a property here, and `additionalProperties: false` means the model
 * cannot smuggle it in. The five fields are the ones a person describes in words; the
 * state is not one of them (RULE-08).
 */
export const workDefinitionDraftSchema = {
  $id: 'work-definition-draft',
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'description', 'operations', 'user_confirmations', 'safety_notes'],
  properties: {
    purpose: { type: 'string' },
    description: { type: 'string' },
    operations: { type: 'array', items: { type: 'string' } },
    user_confirmations: { type: 'array', items: { type: 'string' } },
    safety_notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const BUSINESS_WORK_REQUEST_KEYS = [
  'human_subject', 'purpose', 'description', 'constraints', 'requested_lifetime_hours',
] as const;

export const businessWorkRequestSchema = {
  $id: 'business-work-request',
  type: 'object',
  additionalProperties: false,
  required: [...BUSINESS_WORK_REQUEST_KEYS],
  properties: {
    human_subject: { type: 'string', minLength: 1 },
    purpose: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    constraints: { type: 'object', additionalProperties: { type: 'boolean' } },
    requested_lifetime_hours: { type: 'integer', minimum: 1, maximum: 24 },
  },
} as const;

/**
 * The instruction body has one property. Naming `capabilities`, `tools`, `scope`,
 * `audience` or `url` here — even to reject them — would put the vocabulary of
 * permissions into a request a person can send (RULE-13). With
 * `additionalProperties: false` and one property, any of them is a 400.
 */
export const instructionRequestSchema = {
  $id: 'instruction-request',
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
} as const;

export const AGENT_STATUS_VALUES = [
  'CREATED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'SUSPICIOUS', 'QUARANTINED', 'REVOKED', 'DESTROYED',
] as const;

export const AGENT_STATUS_RESPONSE_KEYS = [
  'agent_status', 'remaining_seconds', 'current_task', 'tool_invocations', 'execution_log',
] as const;

export const agentStatusResponseSchema = {
  $id: 'agent-status-response',
  type: 'object',
  additionalProperties: false,
  required: [...AGENT_STATUS_RESPONSE_KEYS],
  properties: {
    agent_status: { enum: AGENT_STATUS_VALUES },
    remaining_seconds: { type: 'integer', minimum: 0 },
    current_task: { type: ['string', 'null'] },
    tool_invocations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool_id', 'outcome', 'summary'],
        properties: {
          tool_id: { type: 'string' },
          outcome: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
    /**
     * What the agent has done so far, in the words of the Runtime that did it.
     *
     * The same records the timeline replays, read from the checkpoint rather than from
     * the event stream — the timeline waits for a task to finish (RULE-59) and this
     * screen must not, so a person watching a long run has something to read while it
     * is still going. Validating them here means a Runtime that wrote a record of some
     * other shape is a failure on this endpoint, not a broken screen.
     */
    execution_log: { type: 'array', items: activityRecordSchema },
  },
} as const;

export const timelineResponseSchema = {
  $id: 'timeline-response',
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['task_id', 'agent_id', 'purpose', 'status'],
            properties: {
              task_id: { type: 'string' }, agent_id: { type: ['string', 'null'] },
              purpose: { type: 'string' }, status: { const: 'running' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['task_id', 'agent_id', 'purpose', 'status', 'terminal_outcome', 'completed_at', 'events'],
            properties: {
              task_id: { type: 'string' }, agent_id: { type: ['string', 'null'] },
              purpose: { type: 'string' }, status: { const: 'completed' },
              terminal_outcome: { type: 'string' }, completed_at: { type: 'string' },
              events: { type: 'array' },
            },
          },
        ],
      },
    },
  },
} as const;

export const demoReplayRequestSchema = {
  $id: 'demo-replay-request',
  type: 'object',
  additionalProperties: false,
  required: ['scenario_id'],
  properties: { scenario_id: { type: 'string', minLength: 1 } },
} as const;
