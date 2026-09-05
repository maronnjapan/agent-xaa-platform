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
 * Two values are read; nothing else is touched. No spread, so a model response carrying
 * `api_base_url`, `scope`, `audience` or `headers` loses them here rather than
 * downstream — and `executeTool` takes this narrowed type, so a raw response object
 * cannot reach it at all. Every value that decides where a request goes and with what
 * authority comes from the manifest.
 *
 * The arguments arrive in one of two forms and mean the same thing either way. A caller
 * holding a decoded object passes `parameters`; the reasoning loop's model answers
 * `parameters_json`, because Vertex's `responseSchema` cannot describe a map whose keys
 * differ per tool (see `REASONING_SCHEMA`). Decoding is the whole of what the second
 * form adds: the result is a plain object of named arguments or it is nothing, so text
 * that is prose, an array or a bare number is `invalid_tool_call` rather than a call
 * built from a value nobody can read.
 */
export function parseToolCall(raw: unknown): ToolCall | InvalidToolCall {
  if (!isPlainObject(raw)) return invalid();
  const toolId = raw.tool_id;
  if (typeof toolId !== 'string') return invalid();
  const parameters = readParameters(raw);
  if (parameters === undefined) return invalid();
  return { tool_id: toolId, parameters };
}

function readParameters(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const inline = raw.parameters;
  if (inline !== undefined) return isPlainObject(inline) ? inline : undefined;

  const encoded = raw.parameters_json;
  if (typeof encoded !== 'string') return undefined;
  // An empty answer is "this tool takes no arguments", which is a call, not a failure:
  // `internal.document.list` declares no parameters and is the first thing most work
  // needs. What the tool actually requires is checked against the manifest in step6.
  if (encoded.trim() === '') return {};
  try {
    const decoded: unknown = JSON.parse(encoded);
    return isPlainObject(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isInvalidToolCall(value: ToolCall | InvalidToolCall): value is InvalidToolCall {
  return 'outcome' in value;
}

function invalid(): InvalidToolCall {
  return { outcome: 'failed', reason: 'invalid_tool_call', error_code: 'invalid_tool_call' };
}
