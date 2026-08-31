import { compile, toolManifestSchema, type CatalogConnector, type CatalogTool, type ToolManifest } from '@xaa/contracts';

const assertManifest: (value: unknown) => asserts value is ToolManifest = compile<ToolManifest>(toolManifestSchema);

/** Key names that must never appear anywhere in a manifest. */
const FORBIDDEN_KEYS = ['secret', 'client_secret', 'refresh_token', 'private', 'd'];

export class ManifestContainsSecret extends Error {
  constructor(readonly key: string) { super(`manifest_contains_secret: ${key}`); }
}

/**
 * docs 04 §5. What the Agent Runtime needs to call a tool: where, how, and within
 * what limits.
 *
 * RULE-22 draws the line: the manifest carries connection details but no credential.
 * The recursive scan below runs on every build rather than in review, because a
 * catalogue row that gains a `client_secret` would otherwise ship it to the agent.
 *
 * Constraints merge the catalogue's declared keys with what the Policy Engine
 * decided for this agent. Keys the catalogue never declared are not added: a
 * constraint the tool does not understand would be silently ignored at call time.
 */
export function buildToolManifest(input: {
  agentId: string;
  expiresAt: string;
  tools: CatalogTool[];
  connectors: CatalogConnector[];
  addedConstraints: Record<string, Record<string, unknown>>;
}): ToolManifest {
  const connectorById = new Map(input.connectors.map((connector) => [connector.connector_id, connector]));

  const manifest: ToolManifest = {
    agent_id: input.agentId,
    expires_at: input.expiresAt,
    tools: input.tools.map((tool) => {
      const connector = connectorById.get(tool.connector_id);
      const declared = tool.constraints;
      const decided = input.addedConstraints[tool.required_capability] ?? {};
      const constraints: Record<string, unknown> = { ...declared };
      for (const [key, value] of Object.entries(decided)) {
        if (key in declared) constraints[key] = value;
      }
      return {
        tool_id: tool.tool_id,
        description: tool.description,
        required_capability: tool.required_capability,
        authorization: {
          type: tool.authorization.type,
          audience: tool.authorization.audience,
          resource: tool.authorization.resource,
          scope: tool.authorization.scope,
        },
        // 00b: the bridge's absolute URL for a bridged tool, null for a native one.
        token_provider: connector?.resource_type === 'oauth_bridge' ? tool.token_provider : null,
        api: { base_url: tool.api.base_url, method: tool.api.method, path: tool.api.path },
        parameters: tool.parameters,
        constraints,
        response_schema: tool.response_schema,
      };
    }),
  };

  assertNoSecrets(manifest);
  assertManifest(manifest);
  return manifest;
}

function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 12 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) assertNoSecrets(item, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) throw new ManifestContainsSecret(key);
    assertNoSecrets(item, depth + 1);
  }
}
