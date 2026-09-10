/**
 * The failure exercises a person may run against their own agent.
 *
 * The vocabulary is here rather than in either application because the request crosses
 * between them through Firestore and nothing else: the Automation App writes the fault
 * onto an ordinary instruction, the Agent Runtime reads it out of the same document,
 * and both then have to name the same failure back to the same person. Two private
 * copies of these strings would drift, and the drift would look like a missing feature
 * rather than a bug — the exercise would be requested and silently never applied.
 *
 * Three kinds, each a different way a running agent goes wrong, and each something the
 * platform can show afterwards. A fault is a deliberate way to break a running agent,
 * so an addition here has to come with the screen that explains it; an open vocabulary
 * would let a caller ask for a failure no screen can account for.
 *
 * - `runtime_crash`: the Runtime throws at the head of the next step. The execution
 *   ends at once, the model is never asked, and the Job exits as failed.
 * - `model_unavailable`: the Runtime does not call the model on the next step and
 *   treats the step as unanswered, which is the path a model outage takes. The
 *   execution ends as failed with that step on the record.
 * - `tool_failure`: the next tool the model chooses is not executed and comes back as
 *   a failed call. The execution goes on — the loop is what decides whether to keep
 *   going, and this is the exercise of that decision.
 */
export const FAULT_KINDS = ['runtime_crash', 'model_unavailable', 'tool_failure'] as const;

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
export const EXECUTION_FAILURES = ['injected_runtime_crash', 'injected_model_unavailable'] as const;

export type ExecutionFailure = (typeof EXECUTION_FAILURES)[number];

export function isExecutionFailure(value: unknown): value is ExecutionFailure {
  return typeof value === 'string' && (EXECUTION_FAILURES as readonly string[]).includes(value);
}

/**
 * The failure each fault produces, so the request and the result are one mapping.
 *
 * `null` is a fault the execution survives: a failed tool call is a step of the run,
 * not the end of it, so it leaves no execution failure behind — only the record of
 * the step, and the request id the Runtime writes down when it applies it.
 */
export const FAULT_FAILURE = {
  runtime_crash: 'injected_runtime_crash',
  model_unavailable: 'injected_model_unavailable',
  tool_failure: null,
} as const satisfies Readonly<Record<FaultKind, ExecutionFailure | null>>;
