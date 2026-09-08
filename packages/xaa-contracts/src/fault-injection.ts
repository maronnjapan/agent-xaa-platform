/**
 * The failure exercise a person may run against their own agent.
 *
 * The vocabulary is here rather than in either application because the request crosses
 * between them through Firestore and nothing else: the Automation App writes the fault
 * onto an ordinary instruction, the Agent Runtime reads it out of the same document,
 * and both then have to name the same failure back to the same person. Two private
 * copies of these strings would drift, and the drift would look like a missing feature
 * rather than a bug — the exercise would be requested and silently never applied.
 *
 * The list has one entry on purpose. A fault is a deliberate way to break a running
 * agent, so every addition has to be something the platform can also make visible
 * afterwards; an open vocabulary here would let a caller ask for a failure no screen
 * can explain.
 */
export const FAULT_KINDS = ['runtime_crash'] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export function isFaultKind(value: unknown): value is FaultKind {
  return typeof value === 'string' && (FAULT_KINDS as readonly string[]).includes(value);
}

/**
 * A fault as it is stored, bound to the one execution it may interrupt.
 *
 * The task is recorded when the request is accepted, from the checkpoint, never from
 * the caller: a fault that could name its own target would outlive the execution the
 * person was looking at and land on a later one they never asked about.
 */
export interface InstructionFault {
  kind: FaultKind;
  task_id: string;
}

/**
 * How an execution ended when it did not end by itself.
 *
 * The status endpoint copies this to the browser by value, so it is a closed list for
 * the same reason the tool error codes are: whatever a Runtime happens to have written
 * into its checkpoint, only a string named here can reach a person's screen.
 */
export const EXECUTION_FAILURES = ['injected_runtime_crash'] as const;

export type ExecutionFailure = (typeof EXECUTION_FAILURES)[number];

export function isExecutionFailure(value: unknown): value is ExecutionFailure {
  return typeof value === 'string' && (EXECUTION_FAILURES as readonly string[]).includes(value);
}

/** The failure each fault produces, so the request and the result are one mapping. */
export const FAULT_FAILURE: Readonly<Record<FaultKind, ExecutionFailure>> = {
  runtime_crash: 'injected_runtime_crash',
};
