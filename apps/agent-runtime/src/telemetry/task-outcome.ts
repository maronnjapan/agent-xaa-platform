import type { ToolResult } from '../tool-executor/errors.js';

export type TaskOutcome = 'TASK_BLOCKED' | 'TASK_FAILED' | 'TASK_COMPLETED';

/**
 * One task, one verdict, in a fixed order of precedence.
 *
 * Blocked wins over failed because the two answer different questions. A failure says
 * the platform had trouble; a block says the agent tried to exceed what a person
 * granted it. When both happened, the second is the one the person needs to see.
 *
 * A task with no tool calls completed: it asked for nothing and was refused nothing.
 */
export function decideTaskOutcome(results: readonly ToolResult[]): TaskOutcome {
  if (results.some((result) => result.outcome === 'blocked')) return 'TASK_BLOCKED';
  if (results.some((result) => result.outcome === 'failed')) return 'TASK_FAILED';
  return 'TASK_COMPLETED';
}

/**
 * RULE-59 needs exactly one terminal event per task — a missing one leaves the
 * timeline unplayable, a duplicate makes it play twice. The flag lives with the
 * emitter so both the normal path and the `finally` on an exception go through it.
 */
export function createTerminalEmitter(emit: (outcome: TaskOutcome) => Promise<void>): {
  emitTerminalOnce(outcome: TaskOutcome): Promise<void>;
  emitted(): boolean;
} {
  let emitted = false;
  return {
    async emitTerminalOnce(outcome) {
      if (emitted) return;
      emitted = true;
      await emit(outcome);
    },
    emitted: () => emitted,
  };
}
