import type { ToolManifest } from '@xaa/contracts';
import type { ToolDefinition } from '../../manifest/load.js';
import type { ToolBlocked } from '../errors.js';

/**
 * step2. The first thing that happens to a tool call, before any client exists.
 *
 * The lookup is a Map `get` on the exact id. No wildcard, no prefix, no case folding:
 * every one of those would turn "the model asked for something close to a permitted
 * tool" into "the platform granted it". REQ-02-026's demo — an out-of-permission
 * request that produces zero calls to the Agent OP and zero to the Finance API — is
 * this function returning a value instead of raising, before anything opens a socket.
 */
export function buildToolIndex(manifest: ToolManifest): ReadonlyMap<string, ToolDefinition> {
  return new Map(manifest.tools.map((tool) => [tool.tool_id, tool]));
}

export function resolveAllowedTool(
  index: ReadonlyMap<string, ToolDefinition>,
  toolId: string,
): ToolDefinition | ToolBlocked {
  const tool = index.get(toolId);
  if (tool) return tool;
  return {
    outcome: 'blocked',
    reason: 'not_in_allowed_tools',
    error_code: 'tool_not_allowed',
    tool_id: toolId,
    stage: 'tool_selection',
  };
}

export function isBlocked(value: ToolDefinition | ToolBlocked): value is ToolBlocked {
  return 'outcome' in value;
}
