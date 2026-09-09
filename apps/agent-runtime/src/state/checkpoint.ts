import { compile } from '@xaa/contracts';
import type { LogContext, Logger } from '@xaa/logging';
import { sanitizeCheckpoint } from './sanitize.js';

export const checkpointSchema = {
  $id: 'agent-checkpoint',
  type: 'object',
  additionalProperties: false,
  required: ['task_context', 'conversation_context', 'execution_state', 'pending_tool_calls', 'agent_status', 'updated_at'],
  properties: {
    task_context: { type: 'object' },
    conversation_context: { type: 'array' },
    execution_state: { type: 'object' },
    pending_tool_calls: { type: 'array' },
    /**
     * The human-readable account of each step so far (docs 11 §3.4).
     *
     * Optional, because a checkpoint written before the first step has nothing to
     * account for, and because a Runtime that stopped writing it must fail visibly
     * rather than quietly hand the screen an empty list.
     */
    execution_log: { type: 'array' },
    agent_status: { type: 'string', minLength: 1 },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

export interface Checkpoint {
  task_context: Record<string, unknown>;
  conversation_context: unknown[];
  execution_state: Record<string, unknown>;
  pending_tool_calls: unknown[];
  execution_log?: unknown[];
  agent_status: string;
  updated_at: string;
}

const assertCheckpoint: (value: unknown) => asserts value is Checkpoint = compile<Checkpoint>(checkpointSchema);

export interface CheckpointWriter {
  writeState(state: Record<string, unknown>): Promise<void>;
}

/**
 * The only way state reaches Firestore.
 *
 * Validation runs before sanitisation so an unknown top-level key fails loudly rather
 * than being quietly stripped: a writer that invented a seventh key has a bug worth
 * seeing. Sanitisation then runs on the validated shape, and only its output is
 * written — there is no path from a caller's object to the store.
 */
export async function writeCheckpoint(store: CheckpointWriter, state: Checkpoint, logger: Logger, ctx: LogContext): Promise<void> {
  assertCheckpoint(state);
  const sanitized = sanitizeCheckpoint(state, (event) => logger.warning('checkpoint_sanitized', ctx, event)) as Record<string, unknown>;
  await store.writeState(sanitized);
}
