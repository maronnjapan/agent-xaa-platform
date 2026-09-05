/**
 * Every reason a tool call can end other than succeeding.
 *
 * The list is closed on purpose: the reasoning loop, the checkpoint, the stage log
 * and the Activity Event all classify on these strings, and one invented at a call
 * site would show up as an unlabelled failure in all four.
 *
 * `tool_execution_error` is the last of them for a reason: it is what a tool call
 * ends as when something threw that none of the others describe. It exists so that
 * `executeTool` has a value to return for every outcome, rather than a path where it
 * throws and takes the whole Job Execution down with one tool.
 */
export const TOOL_ERROR_CODES = [
  'tool_not_allowed',
  'agent_expired',
  'missing_required_parameter',
  'invalid_path_parameter',
  'constraint_violation',
  'agent_op_error',
  'resource_as_error',
  'bridge_error',
  'resource_api_error',
  'invalid_tool_call',
  'unexpected_token_type',
  'unexpected_subject_response',
  'tool_execution_error',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Where a call got to before it stopped; mirrors the stage log (T-RUN-24). */
export type ToolStage =
  | 'tool_selection' | 'auth_mapping' | 'agent_op' | 'id_jag' | 'token_endpoint' | 'access_token' | 'resource_api';

export interface ToolBlocked {
  outcome: 'blocked';
  reason: 'not_in_allowed_tools' | 'constraint_violation';
  error_code: Extract<ToolErrorCode, 'tool_not_allowed' | 'constraint_violation'>;
  tool_id: string;
  stage: ToolStage;
  constraint?: string;
}

export interface ToolFailed {
  outcome: 'failed';
  reason: string;
  error_code: ToolErrorCode;
  tool_id: string;
  stage: ToolStage;
  status?: number;
}

export interface ToolSucceeded {
  outcome: 'success';
  tool_id: string;
  stage: 'resource_api';
  data: unknown;
}

export type ToolResult = ToolBlocked | ToolFailed | ToolSucceeded;

/**
 * A failure the reasoning loop can read, built from the closed vocabulary only.
 *
 * `reason` is typed as a free string, and a thrown error arrives with a message that
 * may quote a URL, a header or a response body. Passing that through would put it in
 * front of the model and into the checkpoint, where `sanitizeCheckpoint` only drops
 * values it can recognise as tokens. So the message goes to the log and the result
 * carries the code, which is the part every consumer classifies on anyway.
 */
export function toolFailed(input: { toolId: string; stage: ToolStage; errorCode: ToolErrorCode }): ToolFailed {
  return { outcome: 'failed', reason: input.errorCode, error_code: input.errorCode, tool_id: input.toolId, stage: input.stage };
}
