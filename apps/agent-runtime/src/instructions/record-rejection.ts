export interface RejectedInstruction {
  instruction_id: string;
  requested_tool_id: string;
  reason: 'not_in_allowed_tools';
  rejected_at: string;
}

/**
 * RULE-13: an existing agent's permissions never grow.
 *
 * A follow-up instruction asking for something outside the manifest is refused by the
 * same step2 that refuses anything else — there is no separate path for instructions,
 * so there is nothing to widen. What is recorded here is only the fact of the refusal,
 * appended so a second rejection does not erase the first, and read back by the
 * Automation App's status view.
 */
export function appendRejection(
  executionState: Record<string, unknown>,
  rejection: RejectedInstruction,
): Record<string, unknown> {
  const existing = Array.isArray(executionState.rejected_instruction) ? executionState.rejected_instruction : [];
  return { ...executionState, rejected_instruction: [...existing, rejection] };
}
