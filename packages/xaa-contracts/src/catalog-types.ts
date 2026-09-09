import { CAPABILITY_ID_PATTERN, RESOURCE_SCOPES, TOOL_IDS, type ResourceScope, type ToolId } from './identifiers.js';

export type ConnectorId = 'internal-docs-api' | 'internal-finance-api' | 'stub-saas-calendar';
export const CONNECTOR_IDS: readonly ConnectorId[] = ['internal-docs-api', 'internal-finance-api', 'stub-saas-calendar'];

/**
 * RULE-16: connection details live in the catalogue, never in an agent registration.
 * The fields are flat (00b) so a Firestore query can filter on an audience directly.
 */
export interface CatalogConnector {
  connector_id: ConnectorId;
  resource_type: 'native_xaa' | 'oauth_bridge';
  authorization_audience: string;
  authorization_resource: string;
  /** Present only for a bridged connector: the Bridge is the audience there. */
  bridge_audience?: string;
  status: 'ACTIVE' | 'DISABLED';
  risk_level: 'low' | 'medium' | 'high';
  tools: ToolId[];
}

export interface CatalogTool {
  tool_id: ToolId;
  connector_id: ConnectorId;
  description: string;
  /**
   * The capability this tool is the execution of. A string rather than one of the
   * eight shipped ids: which capabilities exist is the taxonomy's answer, and an
   * administrator can add one and map this tool to it (docs 04 §1).
   */
  required_capability: string;
  authorization: { type: 'native_xaa' | 'xaa_bridge'; audience: string; resource: string; scope: ResourceScope };
  /** Absolute Bridge URL for xaa_bridge tools, null for native ones (00b). */
  token_provider: string | null;
  api: { base_url: string; method: 'GET' | 'POST' | 'PATCH'; path: string };
  parameters: Record<string, unknown>;
  constraints: Record<string, unknown>;
  response_schema: { type: string; allowlist: string[] };
  risk_level: 'low' | 'medium' | 'high' | 'critical';
}

export const catalogToolSchema = {
  $id: 'catalog-tool',
  type: 'object',
  additionalProperties: false,
  required: ['tool_id', 'connector_id', 'description', 'required_capability', 'authorization', 'token_provider', 'api', 'parameters', 'constraints', 'response_schema', 'risk_level'],
  properties: {
    tool_id: { type: 'string' },
    connector_id: { enum: CONNECTOR_IDS },
    description: { type: 'string' },
    required_capability: { type: 'string', pattern: CAPABILITY_ID_PATTERN },
    authorization: {
      type: 'object', additionalProperties: false, required: ['type', 'audience', 'resource', 'scope'],
      properties: {
        type: { enum: ['native_xaa', 'xaa_bridge'] },
        audience: { type: 'string' }, resource: { type: 'string' }, scope: { type: 'string' },
      },
    },
    token_provider: { type: ['string', 'null'] },
    api: {
      type: 'object', additionalProperties: false, required: ['base_url', 'method', 'path'],
      properties: { base_url: { type: 'string' }, method: { enum: ['GET', 'POST', 'PATCH'] }, path: { type: 'string' } },
    },
    parameters: { type: 'object' },
    constraints: { type: 'object' },
    response_schema: {
      type: 'object', additionalProperties: false, required: ['type', 'allowlist'],
      properties: { type: { type: 'string' }, allowlist: { type: 'array', items: { type: 'string' } } },
    },
    risk_level: { enum: ['low', 'medium', 'high', 'critical'] },
  },
} as const;

export const catalogConnectorSchema = {
  $id: 'catalog-connector',
  type: 'object',
  additionalProperties: false,
  required: ['connector_id', 'resource_type', 'authorization_audience', 'authorization_resource', 'status', 'risk_level', 'tools'],
  properties: {
    connector_id: { enum: CONNECTOR_IDS },
    resource_type: { enum: ['native_xaa', 'oauth_bridge'] },
    authorization_audience: { type: 'string' },
    authorization_resource: { type: 'string' },
    bridge_audience: { type: 'string' },
    status: { enum: ['ACTIVE', 'DISABLED'] },
    risk_level: { enum: ['low', 'medium', 'high'] },
    tools: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * RULE-22: the manifest carries what the Runtime needs to call an API and nothing
 * that could authenticate as anyone. There is no field for a secret, and the builder
 * rejects one that appears anyway.
 */
export interface ToolManifest {
  agent_id: string;
  expires_at: string;
  tools: Array<{
    tool_id: ToolId;
    description: string;
    required_capability: string;
    authorization: { type: 'native_xaa' | 'xaa_bridge'; audience: string; resource: string; scope: ResourceScope };
    token_provider: string | null;
    api: { base_url: string; method: string; path: string };
    parameters: Record<string, unknown>;
    constraints: Record<string, unknown>;
    response_schema: { type: string; allowlist: string[] };
  }>;
}

export const toolManifestSchema = {
  $id: 'tool-manifest',
  type: 'object',
  additionalProperties: false,
  required: ['agent_id', 'expires_at', 'tools'],
  properties: {
    agent_id: { type: 'string', pattern: '^agent-[0-9a-z]{26}$' },
    expires_at: { type: 'string', format: 'date-time' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool_id', 'description', 'required_capability', 'authorization', 'token_provider', 'api', 'parameters', 'constraints', 'response_schema'],
        properties: {
          tool_id: { enum: TOOL_IDS },
          description: { type: 'string' },
          // Checked by shape, not by membership of the shipped eight: a manifest for an
          // agent granted an administrator-defined capability is still a valid manifest.
          required_capability: { type: 'string', pattern: CAPABILITY_ID_PATTERN },
          authorization: {
            type: 'object', additionalProperties: false, required: ['type', 'audience', 'resource', 'scope'],
            properties: {
              type: { enum: ['native_xaa', 'xaa_bridge'] },
              audience: { type: 'string' }, resource: { type: 'string' }, scope: { enum: RESOURCE_SCOPES },
            },
          },
          token_provider: { type: ['string', 'null'] },
          api: {
            type: 'object', additionalProperties: false, required: ['base_url', 'method', 'path'],
            properties: { base_url: { type: 'string' }, method: { enum: ['GET', 'POST', 'PATCH'] }, path: { type: 'string', pattern: '^/' } },
          },
          parameters: { type: 'object' },
          constraints: { type: 'object' },
          response_schema: {
            type: 'object', additionalProperties: false, required: ['type', 'allowlist'],
            properties: { type: { enum: ['object', 'array'] }, allowlist: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^([a-z_][a-z0-9_]*|[a-z_][a-z0-9_]*\\[\\]\\.[a-z_][a-z0-9_]*)$' } } },
          },
        },
      },
    },
  },
} as const;
