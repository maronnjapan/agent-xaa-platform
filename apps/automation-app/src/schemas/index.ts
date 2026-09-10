import { activityRecordSchema } from '@xaa/contracts';

/** JSON Schemas the Automation App validates against, kept together (DEC-APP-05). */
import { EXECUTION_FAILURES } from '@xaa/contracts';

export const suggestionSchema = {
  $id: 'automation-suggestion',
  type: 'object',
  additionalProperties: false,
  required: ['candidate_id', 'title', 'description', 'context', 'done_criteria', 'steps', 'notes'],
  properties: {
    candidate_id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    context: { type: 'string' },
    done_criteria: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
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

/**
 * A ToDo, as this app stores it.
 *
 * The record is the platform's Work Definition (docs 01 §3.4): what a person wants
 * done, in their own words, which the Authorization Platform later turns into
 * permissions. The screen calls it a ToDo because that is what it is to the person —
 * one item on a list, handed to an AI to carry out — and the fields are the ones an
 * agent needs in order to carry it out unattended: a title, a description, the context
 * it should hold while working, what "done" means, the steps if the person has them in
 * mind, and the things it must not do.
 */
export const TODO_STATUS_VALUES = ['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export const TODO_PRIORITY_VALUES = ['high', 'normal', 'low'] as const;
export const TODO_SOURCE_VALUES = ['screen', 'api'] as const;

/** A calendar day, written the one way a date input and an API caller both write it. */
export const DUE_ON_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export const TODO_TITLE_MAX = 200;
export const TODO_TEXT_MAX = 4000;
export const TODO_CONTEXT_MAX = 8000;
export const TODO_LIST_MAX_ITEMS = 50;
export const TODO_LIST_ITEM_MAX = 500;

const TODO_LINES = {
  type: 'array',
  maxItems: TODO_LIST_MAX_ITEMS,
  items: { type: 'string', minLength: 1, maxLength: TODO_LIST_ITEM_MAX },
} as const;

/** What a person (or their API client) writes; everything else the app fills in. */
export const TODO_INPUT_FIELDS = [
  'title', 'description', 'context', 'done_criteria', 'steps', 'notes', 'priority', 'due_on', 'requested_lifetime_minutes',
] as const;

export const WORK_DEFINITION_FIELDS = [
  'work_definition_id', 'human_subject', 'status', ...TODO_INPUT_FIELDS, 'source', 'agent_id',
  'created_at', 'updated_at', 'completed_at',
] as const;

export const workDefinitionSchema = {
  $id: 'work-definition',
  type: 'object',
  additionalProperties: false,
  required: [...WORK_DEFINITION_FIELDS],
  properties: {
    work_definition_id: { type: 'string', minLength: 1 },
    human_subject: { type: 'string', minLength: 1 },
    status: { enum: TODO_STATUS_VALUES },
    title: { type: 'string', minLength: 1, maxLength: TODO_TITLE_MAX },
    description: { type: 'string', maxLength: TODO_TEXT_MAX },
    context: { type: 'string', maxLength: TODO_CONTEXT_MAX },
    done_criteria: TODO_LINES,
    steps: TODO_LINES,
    notes: TODO_LINES,
    priority: { enum: TODO_PRIORITY_VALUES },
    due_on: { type: ['string', 'null'], pattern: DUE_ON_PATTERN },
    requested_lifetime_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
    source: { enum: TODO_SOURCE_VALUES },
    /** The agent carrying this ToDo out, once one has been made for it. */
    agent_id: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    /** When it was marked done or withdrawn; null while it is still open. */
    completed_at: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

/**
 * What one turn of the design conversation may rewrite.
 *
 * `status` is not a property here, and `additionalProperties: false` means the model
 * cannot smuggle it in. The six fields are the ones a person describes in words; the
 * state, the priority and the due date are not among them (RULE-08).
 */
export const DRAFT_FIELDS = ['title', 'description', 'context', 'done_criteria', 'steps', 'notes'] as const;

export const workDefinitionDraftSchema = {
  $id: 'work-definition-draft',
  type: 'object',
  additionalProperties: false,
  required: [...DRAFT_FIELDS],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: TODO_TITLE_MAX },
    description: { type: 'string', maxLength: TODO_TEXT_MAX },
    context: { type: 'string', maxLength: TODO_CONTEXT_MAX },
    done_criteria: TODO_LINES,
    steps: TODO_LINES,
    notes: TODO_LINES,
  },
} as const;

export const BUSINESS_WORK_REQUEST_KEYS = [
  'human_subject', 'purpose', 'description', 'constraints', 'requested_lifetime_minutes',
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
    requested_lifetime_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
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
  'agent_status', 'remaining_seconds', 'current_task', 'execution_failure', 'tool_invocations', 'execution_log',
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
    // How the last execution ended when it did not end by itself. `agent_status` above
    // is the Lifecycle state and stays the nine values of docs 07 §2; a crashed
    // execution is not a tenth one, so it is reported here instead.
    execution_failure: { enum: [...EXECUTION_FAILURES, null] },
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

/**
 * `run_id` is the agent a task belongs to, or the id of the work that is on its way to
 * becoming one (`activity/query.ts`). It is what makes two agents' `task-1` rows two
 * different things to the browser.
 */
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
            required: ['run_id', 'task_id', 'agent_id', 'purpose', 'status'],
            properties: {
              run_id: { type: 'string', minLength: 1 },
              task_id: { type: 'string' }, agent_id: { type: ['string', 'null'] },
              purpose: { type: 'string' }, status: { const: 'running' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['run_id', 'task_id', 'agent_id', 'purpose', 'status', 'terminal_outcome', 'completed_at', 'events'],
            properties: {
              run_id: { type: 'string', minLength: 1 },
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
