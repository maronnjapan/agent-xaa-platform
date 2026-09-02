import { describe, expect, it } from 'vitest';
import {
  assertValidCapabilityId, catalogConnectorSchema, catalogToolSchema, CAPABILITIES, compile,
  CONNECTOR_IDS, RESOURCE_SCOPES, SchemaValidationError, TOOL_BINDINGS, TOOL_IDS,
} from '../src/index.js';

describe('identifiers', () => {
  it('capability ids pass format check', () => expect(() => CAPABILITIES.forEach(assertValidCapabilityId)).not.toThrow());
  it('rejects vendor and method segments', () => {
    expect(() => assertValidCapabilityId('google.calendar.read')).toThrow();
    expect(() => assertValidCapabilityId('document.get')).toThrow();
  });
  it('tool bindings are exhaustive', () => expect(Object.keys(TOOL_BINDINGS).sort()).toEqual([...TOOL_IDS].sort()));

  /**
   * DEC-SCOPE-03 settled one name for each thing, and the counts are how a second one
   * makes itself visible: an alias added anywhere moves one of these four numbers, and
   * that is easier to notice in review than a plausible-looking extra string in a list.
   */
  it('holds exactly the settled number of each name', () => {
    expect(CAPABILITIES).toHaveLength(8);
    expect(RESOURCE_SCOPES).toHaveLength(7);
    expect(TOOL_IDS).toHaveLength(8);
    expect(CONNECTOR_IDS).toHaveLength(3);
    for (const list of [CAPABILITIES, RESOURCE_SCOPES, TOOL_IDS, CONNECTOR_IDS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('refuses a capability that names a vendor and an HTTP method at once', () => {
    // Both halves are wrong on their own: `google` ties a capability to one provider,
    // and `get` describes a call rather than an authority. A capability that carried
    // either would make the catalogue, not the Policy Engine, the thing that decides
    // what a permission means.
    expect(() => assertValidCapabilityId('google.calendar.get')).toThrow(/invalid capability_id/);
    for (const vendor of ['google', 'microsoft', 'github', 'slack']) {
      expect(() => assertValidCapabilityId(`${vendor}.document.read`)).toThrow();
    }
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      expect(() => assertValidCapabilityId(`document.${method}`)).toThrow();
    }
    // Four segments is not the shape either: `<resource>.<object>.<action>` at most.
    expect(() => assertValidCapabilityId('finance.payment.approve.all')).toThrow();
  });
});

describe('the catalogue schemas', () => {
  const assertTool = compile(catalogToolSchema);
  const assertConnector = compile(catalogConnectorSchema);

  function tool(): Record<string, unknown> {
    return {
      tool_id: 'internal.document.get',
      connector_id: 'internal-docs-api',
      description: '書類を1件取得する',
      required_capability: 'document.read',
      authorization: {
        type: 'native_xaa', audience: 'https://resource-docs-as.test',
        resource: 'https://resource-docs-api.test', scope: 'docs.read',
      },
      token_provider: null,
      api: { base_url: 'https://resource-docs-api.test', method: 'GET', path: '/documents/{id}' },
      parameters: {}, constraints: {},
      response_schema: { type: 'object', allowlist: ['document_id'] },
      risk_level: 'medium',
    };
  }

  it('accepts a catalogue row and refuses one carrying an unknown field', () => {
    expect(() => assertTool(tool())).not.toThrow();
    // Strict and closed: an unknown key is a row written against a different idea of
    // the schema, and accepting it silently is how the two ideas both survive.
    expect(() => assertTool({ ...tool(), client_secret: 'oops' })).toThrow(SchemaValidationError);
    expect(() => assertTool({ ...tool(), oauth_scopes: ['docs.read'] })).toThrow(SchemaValidationError);
    expect(catalogToolSchema.additionalProperties).toBe(false);
  });

  it('refuses a connector carrying an unknown field', () => {
    const connector = {
      connector_id: 'internal-docs-api', resource_type: 'native_xaa',
      authorization_audience: 'https://resource-docs-as.test',
      authorization_resource: 'https://resource-docs-api.test',
      status: 'ACTIVE', risk_level: 'medium', tools: ['internal.document.get'],
    };
    expect(() => assertConnector(connector)).not.toThrow();
    expect(() => assertConnector({ ...connector, client_id: 'x' })).toThrow(SchemaValidationError);
    expect(catalogConnectorSchema.additionalProperties).toBe(false);
  });
});
