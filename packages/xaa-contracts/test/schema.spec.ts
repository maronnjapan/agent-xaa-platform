import { describe, expect, it } from 'vitest';
import {
  agentRegistrationSchema,
  compile,
  platformEndpointsSchema,
  SchemaValidationError,
  toolDefinitionSchema,
  xaaStaticConfigSchema,
  PLATFORM_ENDPOINT_KEYS,
} from '../src/schema/index.js';

const validStaticConfig = {
  allowed_audiences: ['https://docs-as.test'],
  resources: ['https://docs-api.test'],
  scopes: ['docs.read'],
  trusted_resource_as: ['https://docs-as.test'],
  expires_at: '2026-01-01T00:00:00Z',
};

const validRegistration = {
  agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
  human_subject: 'user-1',
  status: 'ACTIVE',
  expires_at: '2026-01-01T00:00:00Z',
  isolation_level: 'standard',
  dedicated_op: null,
  client_auth: { jwk_thumbprint: 'abc', public_jwk: { kty: 'EC' } },
  xaa_static_config: validStaticConfig,
};

describe('schema validation', () => {
  const assertRegistration = compile(agentRegistrationSchema);

  it('accepts a well-formed agent registration', () => {
    expect(() => assertRegistration(structuredClone(validRegistration))).not.toThrow();
  });

  it('rejects unknown property on agent registration', () => {
    expect(() => assertRegistration({ ...validRegistration, tool_id: 'internal.document.list' }))
      .toThrow(SchemaValidationError);
  });

  it('rejects an agent_id that does not match the 26-character pattern', () => {
    expect(() => assertRegistration({ ...validRegistration, agent_id: 'agent-01hxyz1234' })).toThrow(SchemaValidationError);
  });

  it('rejects an isolation level outside the two-value domain', () => {
    expect(() => assertRegistration({ ...validRegistration, isolation_level: 'shared' })).toThrow(SchemaValidationError);
  });

  it('requires every static config member', () => {
    const assertStatic = compile(xaaStaticConfigSchema);
    const withoutScopes = Object.fromEntries(Object.entries(validStaticConfig).filter(([key]) => key !== 'scopes'));
    expect(() => assertStatic(withoutScopes)).toThrow(SchemaValidationError);
  });

  it('constrains tool definitions to the fixed identifier sets', () => {
    const assertTool = compile(toolDefinitionSchema);
    expect(() => assertTool({
      tool_id: 'internal.document.list',
      capability_id: 'document.read',
      connector_id: 'internal-docs-api',
      api: { method: 'GET', path: '/documents', scope: 'docs.read' },
    })).not.toThrow();
    expect(() => assertTool({
      tool_id: 'google.calendar.events.list',
      capability_id: 'document.read',
      connector_id: 'internal-docs-api',
      api: { method: 'GET', path: '/documents', scope: 'docs.read' },
    })).toThrow(SchemaValidationError);
  });

  it('pins the platform endpoints object to 18 keys', () => {
    expect(PLATFORM_ENDPOINT_KEYS).toHaveLength(18);
    const assertEndpoints = compile(platformEndpointsSchema);
    const endpoints = Object.fromEntries(PLATFORM_ENDPOINT_KEYS.map((key) => [key,
      key === 'agent_max_lifetime_seconds' ? 86_400
        : key === 'enable_google_bridge' ? false
        : key === 'vertex_model' ? 'gemini-2.5-flash'
        : key === 'vertex_location' ? 'us-central1'
        : 'https://service.test']));
    expect(() => assertEndpoints(endpoints)).not.toThrow();
    expect(() => assertEndpoints({ ...endpoints, jwks_uri: 'https://x.test' })).toThrow(SchemaValidationError);
  });

  it('reports the schema id and instance path without leaking values', () => {
    try {
      assertRegistration({ ...validRegistration, status: 'BROKEN' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).schemaId).toBe('agent-registration');
      expect((error as SchemaValidationError).message).toBe('schema validation failed');
    }
  });
});
