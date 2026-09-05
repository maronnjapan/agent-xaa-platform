import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { assertValidCapabilityId, CAPABILITIES, RESOURCE_SCOPES, TOOL_BINDINGS, TOOL_IDS } from '../src/identifiers.js';
import { DOCUMENT_TYPES, documentCreateSchema, documentPatchSchema } from '../src/document.js';

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
    expect(allow('internal.document.get')).toEqual(['document_id', 'type', 'title', 'occurred_at', 'body', 'version']);
    expect(allow('internal.document.create')).toEqual(['document_id', 'type', 'title']);
    expect(allow('internal.document.update')).toEqual(['document_id', 'version', 'updated_at']);
  });

  /**
   * The catalogue is where a Tool's request schema is written down (docs 04 §1), and
   * `buildApiRequest` drops every argument the catalogue did not declare. A tool that
   * declares fewer parameters than its resource requires therefore cannot be called at
   * all, and the way it fails says nothing: `internal.document.create` declared only
   * `title` and `body`, so the `type` the model sent was dropped on the way out and the
   * Document API answered 400 to every create an agent ever attempted;
   * `internal.document.update` declared no `version`, so every update lost its
   * optimistic lock on the way out and was refused the same way.
   *
   * Read off both sides rather than written out, so the check keeps holding when either
   * the API's schema or the catalogue changes.
   */
  it('declares on each write tool the path segments and the fields the Document API requires', () => {
    for (const [id, schema] of [
      ['internal.document.create', documentCreateSchema],
      ['internal.document.update', documentPatchSchema],
    ] as const) {
      const tool = tools.find((entry) => entry.tool_id === id)!;
      const parameters = tool.parameters as Record<string, { required?: boolean }>;
      const path = [...(tool.api as { path: string }).path.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]!);

      // Nothing is declared that the resource would not read: an argument the API has
      // no field for is one the model was invited to compose for nobody.
      const known = new Set<string>([...path, ...Object.keys(schema.properties)]);
      for (const name of Object.keys(parameters)) expect(known.has(name), `${id} declares ${name}`).toBe(true);

      // And everything the resource insists on is declared as required, so a call
      // missing one is stopped by name before it is sent rather than coming back as an
      // opaque 400 that names no field.
      for (const name of [...path, ...schema.required]) {
        expect(parameters[name]?.required, `${id} must require ${name}`).toBe(true);
      }
    }
  });

  /** The closed set of `type`, in the one place the model gets to read it. */
  it('shows the model which document types exist', () => {
    const create = tools.find((tool) => tool.tool_id === 'internal.document.create')!;
    expect(((create.parameters as Record<string, { enum?: string[] }>).type).enum).toEqual([...DOCUMENT_TYPES]);
  });

  /**
   * An update needs the version it is updating from, and the only way an agent can
   * learn one is to read the document. Leaving `version` out of what a read returns
   * made the write tool unusable however well it was declared.
   */
  it('returns from a read the version a write has to quote', () => {
    const allowed = (id: string) => (tools.find((tool) => tool.tool_id === id)!.response_schema as { allowlist: string[] }).allowlist;
    expect(allowed('internal.document.get')).toContain('version');
    expect(Object.keys(documentPatchSchema.properties)).toContain('version');
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
