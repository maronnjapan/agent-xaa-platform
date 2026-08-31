export const PLATFORM_ENDPOINT_KEYS = [
  'issuer', 'jwks_url', 'xaa_token_url', 'xaa_callback_url', 'subject_token_url',
  'authorization_url', 'provisioner_url', 'lifecycle_url', 'resource_docs_as_issuer',
  'resource_docs_api_url', 'resource_finance_as_issuer', 'resource_finance_api_url',
  'bridge_internal_url', 'stub_saas_op_issuer', 'agent_max_lifetime_seconds',
  'vertex_model', 'vertex_location', 'enable_google_bridge',
] as const;

export interface PlatformEndpoints {
  issuer: string;
  jwks_url: string;
  xaa_token_url: string;
  xaa_callback_url: string;
  subject_token_url: string;
  authorization_url: string;
  provisioner_url: string;
  lifecycle_url: string;
  resource_docs_as_issuer: string;
  resource_docs_api_url: string;
  resource_finance_as_issuer: string;
  resource_finance_api_url: string;
  bridge_internal_url: string;
  stub_saas_op_issuer: string;
  agent_max_lifetime_seconds: number;
  vertex_model: string;
  vertex_location: string;
  enable_google_bridge: boolean;
}

export const platformEndpointsSchema = {
  $id: 'platform-endpoints',
  type: 'object',
  additionalProperties: false,
  required: PLATFORM_ENDPOINT_KEYS,
  properties: Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [key,
    key === 'agent_max_lifetime_seconds' ? { type: 'integer', minimum: 1 } :
    key === 'enable_google_bridge' ? { type: 'boolean' } :
    key === 'vertex_model' || key === 'vertex_location' ? { type: 'string', minLength: 1 } :
    { type: 'string', format: 'uri' },
  ])),
} as const;
