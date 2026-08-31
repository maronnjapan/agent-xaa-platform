/**
 * Every reason a tool call can end other than succeeding.
 *
 * The list is closed on purpose: the reasoning loop, the checkpoint, the stage log
 * and the Activity Event all classify on these strings, and an eleventh invented at a
 * call site would show up as an unlabelled failure in all four.
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
