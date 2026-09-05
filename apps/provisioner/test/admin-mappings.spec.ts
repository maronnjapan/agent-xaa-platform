import { describe, expect, it } from 'vitest';
import { COLLECTIONS } from '@xaa/contracts';
import { createProvisionerHarness, seededTools, ADMIN_PRINCIPAL, type ProvisionerHarness } from '../src/testing/harness.js';
import { resolveAllowedTools } from '../src/catalog/resolve-tools.js';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { buildToolManifest } from '../src/catalog/build-manifest.js';
import { buildXaaConfig } from '../src/catalog/build-xaa-config.js';

/** A capability an administrator added on the Authorization Platform's console. */
const NEW_CAPABILITY = 'contract.review';
const DOCUMENT_LIST = 'internal.document.list';

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

/** The taxonomy, as the Authorization Platform's console leaves it. */
async function seedTaxonomy(harness: ProvisionerHarness, capabilityIds: readonly string[]): Promise<void> {
  for (const capabilityId of capabilityIds) {
    await harness.seedStore.set(COLLECTIONS.CAPABILITY_TAXONOMY, capabilityId, {
      capability_id: capabilityId, resource: capabilityId.split('.')[0], action: capabilityId.split('.').at(-1),
      description: capabilityId,
    });
  }
}

async function capabilityOf(harness: ProvisionerHarness, toolId: string): Promise<string> {
  const tool = await harness.documents.get<{ required_capability: string }>(COLLECTIONS.CATALOG_TOOLS, toolId);
  return tool!.required_capability;
}

describe('the mapping console is reachable only by an administrator', () => {
  it('refuses a caller with no token and one who is not on the list', async () => {
    const harness = await createProvisionerHarness();

    const anonymous = await harness.fetch('/admin/mappings', { headers: { accept: 'application/json' } });
    const stranger = await harness.asAdmin('/admin/mappings', {
      headers: { accept: 'application/json' }, principal: 'sa-automation-app@xaa-test.iam.gserviceaccount.com',
    });

    expect(anonymous.status).toBe(403);
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual({ error: 'admin_only' });
  });

  it('refuses a write from a caller who is not on the list, and changes nothing', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);

    const response = await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS, principal: 'nobody@example.test',
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY } }),
    });

    expect(response.status).toBe(403);
    expect(await capabilityOf(harness, DOCUMENT_LIST)).toBe('document.read');
  });
});

describe('the mapping screen', () => {
  it('lists every resource with its operations and the permission each one needs', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, ['document.read']);

    const response = await harness.asAdmin('/admin/mappings', { headers: { accept: 'application/json' } });
    const body = await response.json() as {
      resources: Array<{ connector_id: string; tools: Array<{ tool_id: string; required_capability: string }> }>;
      capabilities: Array<{ capability_id: string; tool_ids: string[] }>;
    };

    expect(response.status).toBe(200);
    const docs = body.resources.find((resource) => resource.connector_id === 'internal-docs-api')!;
    expect(docs.tools.map((tool) => tool.tool_id)).toContain(DOCUMENT_LIST);
    expect(docs.tools.find((tool) => tool.tool_id === DOCUMENT_LIST)!.required_capability).toBe('document.read');
    expect(body.capabilities.find((capability) => capability.capability_id === 'document.read')!.tool_ids)
      .toContain(DOCUMENT_LIST);
  });

  it('warns about a permission no operation answers to', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);

    const html = await (await harness.asAdmin('/admin/mappings', { headers: { accept: 'text/html' } })).text();

    expect(html).toContain(NEW_CAPABILITY);
    expect(html).toContain('操作が1つも対応していない権限がある');
  });
});

describe('mapping a permission to a resource', () => {
  it('points the operation at the new permission and leaves the rest of the row alone', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);
    const before = seededTools().find((tool) => tool.tool_id === DOCUMENT_LIST)!;

    const response = await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY } }),
    });

    expect(response.status).toBe(200);
    const after = await harness.documents.get<Record<string, unknown>>(COLLECTIONS.CATALOG_TOOLS, DOCUMENT_LIST);
    expect(after!.required_capability).toBe(NEW_CAPABILITY);
    // The connection details are the catalogue's, not the console's: nothing else moved.
    expect(after!.api).toEqual(before.api);
    expect(after!.authorization).toEqual(before.authorization);
    expect(after!.connector_id).toBe(before.connector_id);
  });

  it('records the change with the account that made it', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);

    await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY } }),
    });

    const line = harness.logs
      .map((entry) => JSON.parse(entry) as { event: string; fields: Record<string, unknown> })
      .find((entry) => entry.event === 'admin.mapping_changed')!;
    expect(line.fields).toMatchObject({
      tool_id: DOCUMENT_LIST, from_capability: 'document.read', to_capability: NEW_CAPABILITY,
      admin_principal: ADMIN_PRINCIPAL,
    });
  });

  /**
   * The mapping may only name a capability the taxonomy defines. Anything else is a
   * resource operation no decision could ever reach, since the Policy Engine grants
   * only what the taxonomy holds.
   */
  it('refuses a permission nobody has defined, and writes nothing', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, ['document.read']);

    const response = await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY } }),
    });

    expect(response.status).toBe(400);
    expect(await capabilityOf(harness, DOCUMENT_LIST)).toBe('document.read');
  });

  it('refuses an operation the catalogue does not have', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);

    const response = await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { 'internal.document.destroy': NEW_CAPABILITY } }),
    });

    expect(response.status).toBe(400);
    expect(await harness.documents.get(COLLECTIONS.CATALOG_TOOLS, 'internal.document.destroy')).toBeUndefined();
  });

  it('applies a form submission, which is what the screen sends', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);

    const response = await harness.asAdmin('/admin/mappings', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ [DOCUMENT_LIST]: NEW_CAPABILITY }).toString(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`${DOCUMENT_LIST}：document.read → ${NEW_CAPABILITY}`);
    expect(await capabilityOf(harness, DOCUMENT_LIST)).toBe(NEW_CAPABILITY);
  });
});

/**
 * The mapping is what Provisioning reads. A permission mapped on the console has to
 * resolve to the same tool the Agent is then allowed to call.
 */
describe('a mapped permission resolves to a tool at provisioning time', () => {
  it('hands the agent the operation its new permission is mapped to', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);
    await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY } }),
    });

    const catalogue = await createCatalogRepository(harness.documents).tools();
    const resolved = resolveAllowedTools([NEW_CAPABILITY], catalogue);

    expect(resolved.ok).toBe(true);
    expect(resolved.ok === true && resolved.tools.map((tool) => tool.tool_id)).toEqual([DOCUMENT_LIST]);
  });

  /**
   * The manifest and the XAA config are what the Agent Runtime and the Agent OP are
   * handed. Both are schema-checked, and until this change the check demanded one of
   * the eight capability ids the platform ships with — which would have refused to
   * provision an agent for a permission an administrator had just created.
   */
  it('builds a manifest and an XAA config for a permission the platform does not ship with', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);
    await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY } }),
    });
    const catalogue = createCatalogRepository(harness.documents);
    const resolved = resolveAllowedTools([NEW_CAPABILITY], await catalogue.tools());

    const manifest = buildToolManifest({
      agentId: `agent-${'a'.repeat(26)}`,
      expiresAt: '2026-03-01T08:00:00.000Z',
      tools: resolved.ok ? resolved.tools : [],
      connectors: await catalogue.connectors(),
      addedConstraints: {},
    });

    expect(manifest.tools.map((tool) => tool.required_capability)).toEqual([NEW_CAPABILITY]);
    // The scopes are still the catalogue's own, so the Agent OP's static config is
    // unchanged by which capability the tool answers to.
    expect(buildXaaConfig(resolved.ok ? resolved.tools : []).scopes).toEqual(['docs.read']);
  });

  it('leaves the capability it was moved away from with no tool at all', async () => {
    const harness = await createProvisionerHarness();
    await seedTaxonomy(harness, [NEW_CAPABILITY]);
    // Both document.read tools move, so nothing is left behind to hide the effect.
    await harness.asAdmin('/admin/mappings', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ mappings: { [DOCUMENT_LIST]: NEW_CAPABILITY, 'internal.document.get': NEW_CAPABILITY } }),
    });

    const catalogue = await createCatalogRepository(harness.documents).tools();
    const resolved = resolveAllowedTools(['document.read'], catalogue);

    expect(resolved).toEqual({ ok: false, code: 'no_tool_for_capability', capability_id: 'document.read' });
  });
});
