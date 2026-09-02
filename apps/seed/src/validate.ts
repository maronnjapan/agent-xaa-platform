import connectorSchema from '@xaa/contracts/schema/connector.json' with { type: 'json' };
import toolSchema from '@xaa/contracts/schema/tool.json' with { type: 'json' };
import { assertValidCapabilityId, CAPABILITIES, compile, TOOL_IDS } from '@xaa/contracts';

const assertConnectorSchema: (value: unknown) => asserts value is ConnectorSeed = compile(connectorSchema);
const assertToolSchema: (value: unknown) => asserts value is ToolSeed = compile(toolSchema);

/**
 * The row as it is stored, not a shape of its own.
 *
 * 00b §3 fixes `catalog_connectors` on flat fields, and the Provisioner reads it through
 * `CatalogConnector`. Validating a nested shape here would mean the seed accepted a
 * document the one reader of that collection cannot use.
 */
export interface ConnectorSeed {
  connector_id: string;
  resource_type: 'native_xaa' | 'oauth_bridge';
  tools: string[];
  authorization_audience?: string;
  authorization_resource?: string;
  bridge_audience?: string;
  [key: string]: unknown;
}

export interface ToolSeed {
  tool_id: string;
  connector_id: string;
  required_capability: string;
  authorization: { type: 'native_xaa' | 'xaa_bridge'; audience: string; resource: string; scope: string };
  token_provider: string | null;
  api: { base_url: string; method: string; path: string };
  parameters: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HumanPermissionSeed {
  human_subject: string;
  capability_id: string;
  granted_at?: string;
}

export interface CapabilitySeed {
  capability_id: string;
  [key: string]: unknown;
}

/**
 * DEC-SCOPE-03 / REQ-03-019. Every capability id in the taxonomy is checked against
 * the naming rule before anything is written.
 *
 * The rule exists because a capability id is the vocabulary the Authorization AI is
 * given and the Policy Engine decides on: an id naming a vendor (`google.calendar.read`)
 * or an HTTP method (`document.GET`) would put the implementation back into the
 * permission model that RULE-09 keeps out of it. Every violating row is reported, not
 * just the first, so one run tells the operator everything that has to change.
 */
export function validateSeed(
  connectors: ConnectorSeed[],
  tools: ToolSeed[],
  capabilities: CapabilitySeed[] = [],
  humanPermissions: HumanPermissionSeed[] = [],
): void {
  const errors: string[] = [];
  for (const capability of capabilities) {
    try { assertValidCapabilityId(capability.capability_id); }
    catch { errors.push(`invalid capability_id: ${capability.capability_id}`); }
  }
  const known = new Set(capabilities.map((entry) => entry.capability_id));
  for (const grant of humanPermissions) {
    // A grant of something the taxonomy does not define would sit in the table
    // forever, matching nothing and explaining nothing.
    if (known.size > 0 && !known.has(grant.capability_id)) {
      errors.push(`unknown capability_id in human permission: ${grant.capability_id}`);
    }
    if (!grant.human_subject) errors.push(`human permission without a subject: ${grant.capability_id}`);
  }
  const connectorIds = new Set(connectors.map((entry) => entry.connector_id));
  const toolIds = new Set(tools.map((entry) => entry.tool_id));
  for (const connector of connectors) {
    try { assertConnectorSchema(connector); } catch { errors.push(`${connector.connector_id ?? '<unknown>'} / connector schema`); }
    if (!['native_xaa', 'oauth_bridge'].includes(connector.resource_type)) errors.push(`${connector.connector_id} / resource_type`);
    if (!connector.authorization_audience || !connector.authorization_resource) errors.push(`${connector.connector_id} / authorization_resource`);
    if (connector.resource_type === 'oauth_bridge' && !connector.bridge_audience) errors.push(`${connector.connector_id} / bridge_audience`);
    for (const toolId of connector.tools) if (!toolIds.has(toolId)) errors.push(`${connector.connector_id} / unknown tool ${toolId}`);
  }
  for (const tool of tools) {
    try { assertToolSchema(tool); } catch { errors.push(`${tool.tool_id ?? '<unknown>'} / tool schema`); }
    if (!TOOL_IDS.includes(tool.tool_id as (typeof TOOL_IDS)[number])) errors.push(`${tool.tool_id} / unknown tool_id`);
    try { assertValidCapabilityId(tool.required_capability); } catch { errors.push(`${tool.tool_id} / invalid capability ${tool.required_capability}`); }
    if (!CAPABILITIES.includes(tool.required_capability as (typeof CAPABILITIES)[number])) errors.push(`${tool.tool_id} / unknown capability ${tool.required_capability}`);
    if (!connectorIds.has(tool.connector_id)) errors.push(`${tool.tool_id} / unknown connector ${tool.connector_id}`);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.api.method)) errors.push(`${tool.tool_id} / api.method`);
    for (const placeholder of tool.api.path.matchAll(/\{([^}]+)\}/g)) if (!(placeholder[1]! in tool.parameters)) errors.push(`${tool.tool_id} / missing parameter ${placeholder[1]}`);
    if (tool.authorization.type === 'xaa_bridge' && !tool.token_provider) errors.push(`${tool.tool_id} / token_provider`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
