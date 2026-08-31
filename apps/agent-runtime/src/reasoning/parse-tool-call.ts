export interface ToolCall {
  tool_id: string;
  parameters: Record<string, unknown>;
}

export interface InvalidToolCall {
  outcome: 'failed';
  reason: 'invalid_tool_call';
  error_code: 'invalid_tool_call';
}

/**
 * RULE-18 in the type system: the model says *what*, the manifest says *how*.
 *
 * Two fields are read by name; nothing else is touched. No spread, so a model response
 * carrying `api_base_url`, `scope`, `audience` or `headers` loses them here rather than
 * downstream — and `executeTool` takes this narrowed type, so a raw response object
 * cannot reach it at all. Every value that decides where a request goes and with what
 * authority comes from the manifest.
 */
export function parseToolCall(raw: unknown): ToolCall | InvalidToolCall {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const record = raw as Record<string, unknown>;
  const toolId = record.tool_id;
  const parameters = record.parameters;
  if (typeof toolId !== 'string') return invalid();
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return invalid();
  return { tool_id: toolId, parameters: parameters as Record<string, unknown> };
}

export function isInvalidToolCall(value: ToolCall | InvalidToolCall): value is InvalidToolCall {
  return 'outcome' in value;
}

function invalid(): InvalidToolCall {
  return { outcome: 'failed', reason: 'invalid_tool_call', error_code: 'invalid_tool_call' };
}
