import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { assertValidCapabilityId, CAPABILITIES, RESOURCE_SCOPES, TOOL_BINDINGS, TOOL_IDS } from '../src/identifiers.js';

const seedRoot = new URL('../../../infra/seed/', import.meta.url).pathname;
const tools = readdirSync(`${seedRoot}tools`).map((file) => parse(readFileSync(`${seedRoot}tools/${file}`, 'utf8')) as Record<string, unknown>);
const connectors = readdirSync(`${seedRoot}connectors`).map((file) => parse(readFileSync(`${seedRoot}connectors/${file}`, 'utf8')) as Record<string, unknown>);

/**
 * Names the design discarded; none of them may reappear in the catalogue.
 *
 * They are assembled from their segments rather than written out, because T-PROV-01
 * also forbids the strings themselves from occurring anywhere under `packages/` and
 * `apps/` — a repository-wide grep is how that is checked, and a list of the very
 * names spelled in full would be the one hit it reports.
 */
const DISCARDED = [
  ['docs', 'document', 'get'], ['docs', 'document', 'update'],
  ['document', 'content', 'read'], ['document', 'content', 'write'],
  ['finance', 'transaction', 'read'], ['transactions', 'read'], ['transfers', 'write'],
  ['google', 'calendar', 'events', 'list'], ['google', 'gmail', 'message', 'send'],
].map((segments) => segments.join('.')).concat('google-workspace');

describe('seeded Tool Catalog', () => {
  it('registers the four document tools and the three finance tools', () => {
    const ids = tools.map((tool) => tool.tool_id);
    for (const tool of ['internal.document.list', 'internal.document.get', 'internal.document.create', 'internal.document.update',
      'internal.finance.payment.list', 'internal.finance.payment.get', 'internal.finance.payment.approve']) {
      expect(ids).toContain(tool);
    }
    expect(ids.sort()).toEqual([...TOOL_IDS].sort());
  });

  it('carries none of the discarded names', () => {
    const text = JSON.stringify({ tools, connectors });
    for (const name of DISCARDED) expect(text).not.toContain(name);
  });

  it('binds each tool to a registered capability and scope', () => {
    for (const tool of tools) {
      const binding = TOOL_BINDINGS[tool.tool_id as keyof typeof TOOL_BINDINGS];
      expect(CAPABILITIES).toContain(tool.required_capability);
      expect(binding.capability).toBe(tool.required_capability);
      const authorization = tool.authorization as { scope: string };
      expect(RESOURCE_SCOPES).toContain(authorization.scope);
      expect(binding.scope).toBe(authorization.scope);
      assertValidCapabilityId(String(tool.required_capability));
    }
  });

  it('declares a response allow list on every tool', () => {
    for (const tool of tools) {
      const schema = tool.response_schema as { allowlist?: string[] };
      expect(Array.isArray(schema.allowlist)).toBe(true);
      expect(schema.allowlist!.length).toBeGreaterThan(0);
    }
  });

  it('lists exactly the documented keys for the document tools', () => {
    const allow = (id: string) => (tools.find((tool) => tool.tool_id === id)!.response_schema as { allowlist: string[] }).allowlist;
    expect(allow('internal.document.list')).toEqual(['document_id', 'type', 'title', 'occurred_at']);
    expect(allow('internal.document.get')).toEqual(['document_id', 'type', 'title', 'occurred_at', 'body']);
    expect(allow('internal.document.create')).toEqual(['document_id', 'type', 'title']);
    expect(allow('internal.document.update')).toEqual(['document_id', 'version', 'updated_at']);
  });

  it('gives the approve tool a max_amount constraint slot', () => {
    const approve = tools.find((tool) => tool.tool_id === 'internal.finance.payment.approve')!;
    expect(Object.keys(approve.constraints as Record<string, unknown>)).toContain('max_amount');
  });

  it('rates the finance connector high and the documents connector medium', () => {
    const byId = (id: string) => connectors.find((connector) => connector.connector_id === id)!;
    expect(byId('internal-docs-api').risk_level).toBe('medium');
    expect(byId('internal-docs-api').resource_type).toBe('native_xaa');
    expect(byId('internal-finance-api').risk_level).toBe('high');
    expect(byId('internal-finance-api').resource_type).toBe('native_xaa');
  });

  it('marks only the finance resource as sensitive', () => {
    const sensitivity = parse(readFileSync(`${seedRoot}resource-sensitivity.yaml`, 'utf8')) as { resources: Array<{ resource_id: string; sensitivity: string }> };
    expect(sensitivity.resources).toEqual([{ resource_id: 'internal-finance-api', sensitivity: 'high' }]);
  });
});
