import { describe, expect, it } from 'vitest';
import { CAPABILITIES, TOOL_IDS } from '@xaa/contracts';
import { resolveAllowedTools } from '../src/catalog/resolve-tools.js';
import { buildXaaConfig, InvalidXaaConfig } from '../src/catalog/build-xaa-config.js';
import { buildToolManifest, ManifestContainsSecret } from '../src/catalog/build-manifest.js';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { createProvisionerHarness, seededConnectors, seededTools } from './helpers.js';

const catalogue = seededTools();
const connectors = seededConnectors();

describe('resolving capabilities to tools', () => {
  it('expands document.read and document.write to the four document tools', () => {
    const result = resolveAllowedTools(['document.read', 'document.write'], catalogue);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tools.map((tool) => tool.tool_id)).toEqual([
      'internal.document.create', 'internal.document.get', 'internal.document.list', 'internal.document.update',
    ]);
    expect(result.connectorIds).toEqual(['internal-docs-api']);
  });

  it('expands one capability to every tool that needs it', () => {
    const result = resolveAllowedTools(['document.read'], catalogue);
    expect(result.ok && result.tools.map((tool) => tool.tool_id)).toEqual(['internal.document.get', 'internal.document.list']);
  });

  it('reports the first capability with no tool', () => {
    const result = resolveAllowedTools(['mail.message.send', 'document.read'], catalogue);
    expect(result).toEqual({ ok: false, code: 'no_tool_for_capability', capability_id: 'mail.message.send' });
  });

  it('is stable across repeated calls', () => {
    const first = resolveAllowedTools([...CAPABILITIES].filter((capability) => capability !== 'mail.message.send' && capability !== 'mail.message.read' && capability !== 'calendar.event.write'), catalogue);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(resolveAllowedTools([...CAPABILITIES].filter((capability) => capability !== 'mail.message.send' && capability !== 'mail.message.read' && capability !== 'calendar.event.write'), catalogue)).toEqual(first);
    }
  });

  it('covers every seeded tool id', () => {
    expect(catalogue.map((tool) => tool.tool_id).sort()).toEqual([...TOOL_IDS].sort());
  });
});

describe('building the static XAA configuration', () => {
  it('derives two scopes and one resource from the four document tools', () => {
    const resolved = resolveAllowedTools(['document.read', 'document.write'], catalogue);
    const config = buildXaaConfig(resolved.ok ? resolved.tools : []);
    expect(config.scopes).toEqual(['docs.read', 'docs.write']);
    expect(config.resources).toHaveLength(1);
    expect(config.allowed_audiences).toEqual(['https://resource-docs-as.test']);
  });

  it('grants only the read scope for a read-only capability', () => {
    const resolved = resolveAllowedTools(['document.read'], catalogue);
    expect(buildXaaConfig(resolved.ok ? resolved.tools : []).scopes).toEqual(['docs.read']);
  });

  it('refuses a resource carrying a fragment', () => {
    const [tool] = catalogue;
    expect(() => buildXaaConfig([{ ...tool!, authorization: { ...tool!.authorization, resource: 'https://api.test/x#frag' } }]))
      .toThrow(InvalidXaaConfig);
  });

  it('refuses a non-https audience', () => {
    const [tool] = catalogue;
    expect(() => buildXaaConfig([{ ...tool!, authorization: { ...tool!.authorization, audience: 'http://as.test' } }]))
      .toThrow(InvalidXaaConfig);
  });

  it('returns exactly three keys', () => {
    const resolved = resolveAllowedTools(['document.read'], catalogue);
    expect(Object.keys(buildXaaConfig(resolved.ok ? resolved.tools : [])).sort())
      .toEqual(['allowed_audiences', 'resources', 'scopes']);
  });
});

describe('building the tool manifest', () => {
  const agentId = 'agent-abcdefghijklmnopqrstuvwxyz';
  const expiresAt = '2026-03-02T00:00:00Z';

  it('carries no secret-shaped key anywhere', () => {
    const resolved = resolveAllowedTools(['document.read', 'finance.payment.approve'], catalogue);
    const manifest = buildToolManifest({
      agentId, expiresAt, tools: resolved.ok ? resolved.tools : [], connectors, addedConstraints: {},
    });
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      for (const [key, item] of Object.entries(value)) { keys.push(key); walk(item); }
    };
    walk(manifest);
    for (const forbidden of ['secret', 'client_secret', 'refresh_token', 'd']) expect(keys).not.toContain(forbidden);
  });

  it('fills max_amount from the policy decision', () => {
    const resolved = resolveAllowedTools(['finance.payment.approve'], catalogue);
    const manifest = buildToolManifest({
      agentId, expiresAt, tools: resolved.ok ? resolved.tools : [], connectors,
      addedConstraints: { 'finance.payment.approve': { max_amount: 100_000 } },
    });
    expect(manifest.tools[0]!.constraints.max_amount).toBe(100_000);
  });

  it('does not add a constraint key the catalogue never declared', () => {
    const resolved = resolveAllowedTools(['document.read'], catalogue);
    const manifest = buildToolManifest({
      agentId, expiresAt, tools: resolved.ok ? resolved.tools : [], connectors,
      addedConstraints: { 'document.read': { max_amount: 1 } },
    });
    expect(manifest.tools[0]!.constraints).toEqual({});
  });

  it('throws when a secret reaches the builder', () => {
    const [tool] = catalogue;
    expect(() => buildToolManifest({
      agentId, expiresAt, connectors, addedConstraints: {},
      tools: [{ ...tool!, parameters: { client_secret: 'oops' } }],
    })).toThrow(ManifestContainsSecret);
  });

  it('leaves token_provider null for a native tool', () => {
    const resolved = resolveAllowedTools(['document.read'], catalogue);
    const manifest = buildToolManifest({ agentId, expiresAt, tools: resolved.ok ? resolved.tools : [], connectors, addedConstraints: {} });
    expect(manifest.tools.every((tool) => tool.token_provider === null)).toBe(true);
  });

  it('fixes the manifest to three top-level keys', () => {
    const resolved = resolveAllowedTools(['document.read'], catalogue);
    const manifest = buildToolManifest({ agentId, expiresAt, tools: resolved.ok ? resolved.tools : [], connectors, addedConstraints: {} });
    expect(Object.keys(manifest).sort()).toEqual(['agent_id', 'expires_at', 'tools']);
  });
});

/**
 * Turning a connector off is how an operator stops agents reaching a service. The
 * repository is the only place that can honour it: everything downstream — the
 * resolution, the manifest, the registration — takes the rows it hands over as the
 * whole catalogue.
 */
describe('the catalogue repository', () => {
  async function seeded(status: 'ACTIVE' | 'DISABLED') {
    const harness = await createProvisionerHarness();
    const target = connectors.find((connector) => connector.connector_id === 'internal-docs-api')!;
    await harness.seedStore.set('catalog_connectors', target.connector_id, { ...target, status });
    return createCatalogRepository(harness.documents);
  }

  it('hides a disabled connector and every tool under it', async () => {
    const repository = await seeded('DISABLED');
    expect((await repository.connectors()).map((connector) => connector.connector_id)).not.toContain('internal-docs-api');
    expect((await repository.tools()).some((tool) => tool.connector_id === 'internal-docs-api')).toBe(false);
    expect(await repository.findConnectorById('internal-docs-api')).toBeUndefined();
    expect(await repository.findToolById('internal.document.get')).toBeUndefined();
    expect(await repository.findToolsByCapability('document.read')).toEqual([]);
  });

  it('hands over the tools of an active connector', async () => {
    const repository = await seeded('ACTIVE');
    expect((await repository.findToolsByCapability('document.read')).length).toBeGreaterThan(0);
    expect(await repository.findToolById('internal.document.get')).toBeDefined();
  });

  it('leaves an agent no tool for a capability whose connector was turned off', async () => {
    const repository = await seeded('DISABLED');
    const result = resolveAllowedTools(['document.read'], await repository.tools());
    expect(result).toEqual({ ok: false, code: 'no_tool_for_capability', capability_id: 'document.read' });
  });
});
