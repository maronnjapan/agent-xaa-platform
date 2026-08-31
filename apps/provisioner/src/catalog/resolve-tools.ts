import type { CatalogTool, ConnectorId } from '@xaa/contracts';

export type ResolveResult =
  | { ok: true; tools: CatalogTool[]; connectorIds: ConnectorId[] }
  | { ok: false; code: 'no_tool_for_capability'; capability_id: string };

/**
 * docs 04 §5. Turns the capabilities the Policy Engine granted into the concrete
 * tools an agent may call.
 *
 * A capability with no tool aborts provisioning rather than producing an agent that
 * holds an authority it can never use. Failure is a return value, not an exception:
 * the caller has to mark the transaction FAILED and record the step either way.
 *
 * The order is stable so the manifest, the registration and the job environment
 * agree byte for byte across retries.
 */
export function resolveAllowedTools(capabilities: string[], catalogue: CatalogTool[]): ResolveResult {
  const byCapability = new Map<string, CatalogTool[]>();
  for (const tool of catalogue) {
    byCapability.set(tool.required_capability, [...(byCapability.get(tool.required_capability) ?? []), tool]);
  }

  const tools = new Map<string, CatalogTool>();
  for (const capability of capabilities) {
    const matches = byCapability.get(capability) ?? [];
    // The first failing capability in input order is the one reported.
    if (matches.length === 0) return { ok: false, code: 'no_tool_for_capability', capability_id: capability };
    for (const tool of matches) tools.set(tool.tool_id, tool);
  }

  const sorted = [...tools.values()].sort((left, right) => left.tool_id.localeCompare(right.tool_id));
  return {
    ok: true,
    tools: sorted,
    connectorIds: [...new Set(sorted.map((tool) => tool.connector_id))].sort(),
  };
}
