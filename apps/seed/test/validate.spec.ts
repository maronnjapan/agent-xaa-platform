import { describe, expect, it } from 'vitest';
import { validateSeed, type ConnectorSeed, type ToolSeed } from '../src/validate.js';

const connector: ConnectorSeed = {
  connector_id: 'internal-docs-api',
  resource_type: 'native_xaa',
  authorization: { audience: 'https://as.example', resource: 'https://api.example' },
  status: 'ACTIVE',
  risk_level: 'medium',
  tools: ['internal.document.get'],
};
const tool: ToolSeed = {
  tool_id: 'internal.document.get',
  connector_id: 'internal-docs-api',
  description: 'Get a document',
  required_capability: 'document.read',
  authorization: { type: 'native_xaa', audience: 'https://as.example', resource: 'https://api.example', scope: 'docs.read' },
  token_provider: null,
  api: { base_url: 'https://api.example', method: 'GET', path: '/documents/{id}' },
  parameters: { id: {} },
  constraints: {},
  response_schema: { type: 'object' },
  risk_level: 'low',
};

describe('seed validation', () => {
  it('accepts a valid connector and tool', () => expect(() => validateSeed([connector], [tool])).not.toThrow());
  it('rejects native_xaa connector without authorization.resource', () => expect(() => validateSeed([{ ...connector, authorization: undefined }], [tool])).toThrow(/authorization.resource/));
  it('rejects unknown resource_type', () => expect(() => validateSeed([{ ...connector, resource_type: 'unknown' as 'native_xaa' }], [tool])).toThrow(/resource_type/));
  it('rejects api.method FETCH', () => expect(() => validateSeed([connector], [{ ...tool, api: { ...tool.api, method: 'FETCH' } }])).toThrow(/api.method/));
  it('rejects path placeholder missing from parameters', () => expect(() => validateSeed([connector], [{ ...tool, parameters: {} }])).toThrow(/missing parameter id/));
});
