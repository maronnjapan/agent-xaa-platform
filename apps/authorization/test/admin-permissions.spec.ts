import { describe, expect, it } from 'vitest';
import { createLogger } from '@xaa/logging';
import { ADMIN_ROUTES, ROUTES } from '../src/routes/index.js';
import { AUTHZ_COLLECTIONS } from '../src/store/collections.js';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import { decide } from '../src/pipeline/decide.js';
import { parsePermission } from '../src/admin/permission.js';
import {
  ADMIN_PRINCIPAL, createAuthzHarness, createFakeVertex, logLines, testConfig, type AuthzHarness,
} from './helpers.js';

/** A capability the platform does not ship with, which is the whole point of the console. */
const NEW_CAPABILITY = 'contract.review';

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

function form(values: Record<string, string>): RequestInit {
  return { method: 'POST', headers: FORM, body: new URLSearchParams(values).toString() };
}

function json(values: Record<string, unknown>): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(values) };
}

async function taxonomyRow(harness: AuthzHarness, capabilityId: string): Promise<Record<string, unknown> | undefined> {
  return harness.documents.get(AUTHZ_COLLECTIONS.capabilityTaxonomy, capabilityId);
}

describe('the permission console is reachable only by an administrator', () => {
  it('refuses a request with no token, an unlisted account, or a token for another service', async () => {
    const harness = await createAuthzHarness();

    const anonymous = await harness.fetch('/admin/permissions', { headers: { accept: 'application/json' } });
    const stranger = await harness.asAdmin('/admin/permissions', {
      headers: { accept: 'application/json' }, principal: 'sa-automation-app@xaa-test.iam.gserviceaccount.com',
    });

    expect(anonymous.status).toBe(403);
    expect(stranger.status).toBe(403);
    // The same body either way: the refusal must not answer whether an account is one
    // of the platform's administrators.
    expect(await anonymous.json()).toEqual({ error: 'admin_only' });
    expect(await stranger.json()).toEqual({ error: 'admin_only' });
    expect(logLines(harness).filter((line) => line.event === 'admin.refused')).toHaveLength(2);
  });

  /**
   * RULE-07 is about Automation App, and it is Automation App's own service account
   * that could most plausibly try: any Cloud Run service can mint a Google token for
   * any audience, so the audience alone would let it in. The list is what does not.
   */
  it('keeps the taxonomy out of reach of a caller who is not on the list', async () => {
    const harness = await createAuthzHarness();
    const response = await harness.asAdmin('/admin/permissions', {
      headers: { accept: 'application/json' }, principal: 'sa-automation-app@xaa-test.iam.gserviceaccount.com',
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('capability');
  });

  it('names every console route in a table separate from the decision surface', () => {
    // The decision surface still has exactly one GET, which is the property RULE-07
    // rests on for the callers it was written about.
    expect(ROUTES.filter((route) => route.method === 'GET')).toHaveLength(1);
    expect(ADMIN_ROUTES.every((route) => route.path.startsWith('/admin'))).toBe(true);
  });
});

describe('the permission list', () => {
  it('shows every capability with its delegation, its resources and who holds it', async () => {
    const harness = await createAuthzHarness();

    const response = await harness.asAdmin('/admin/permissions', { headers: { accept: 'application/json' } });
    const body = await response.json() as { permissions: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    const document = body.permissions.find((permission) => permission.capability_id === 'document.read')!;
    expect(document.delegatable).toBe(true);
    expect(document.connector_ids).toEqual(['internal-docs-api']);
    expect(document.holders).toBe(1);
    // calendar.event.write is seeded as not delegatable, and the screen has to say so:
    // it is the one case where the human holds a permission their agent may not.
    expect(body.permissions.find((permission) => permission.capability_id === 'calendar.event.write')!.delegatable).toBe(false);
  });

  it('renders the list as a page a browser can use', async () => {
    const harness = await createAuthzHarness();
    const response = await harness.asAdmin('/admin/permissions', { headers: { accept: 'text/html' } });
    const html = await response.text();

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('document.read');
    expect(html).toContain('/admin/permissions/new');
  });
});

describe('creating a permission', () => {
  it('writes the taxonomy entry and the delegation row together', async () => {
    const harness = await createAuthzHarness();

    const response = await harness.asAdmin('/admin/permissions', json({
      capability_id: NEW_CAPABILITY, description: '契約書をレビューする', capability_risk: 'medium',
      sensitive_resource: true, delegatable: true,
    }));

    expect(response.status).toBe(201);
    expect(await taxonomyRow(harness, NEW_CAPABILITY)).toEqual({
      capability_id: NEW_CAPABILITY, resource: 'contract', object: 'contract', action: 'review',
      description: '契約書をレビューする',
      default_characteristics: {
        capability_risk: 'medium', sensitive_resource: true, admin_permission: false, personal_data_access: false,
      },
    });
    expect(await harness.documents.get(AUTHZ_COLLECTIONS.delegatablePermissions, NEW_CAPABILITY))
      .toEqual({ capability_id: NEW_CAPABILITY, delegatable: true, policy_id: `del-${NEW_CAPABILITY}` });
  });

  it('records who made the change', async () => {
    const harness = await createAuthzHarness();
    await harness.asAdmin('/admin/permissions', json({
      capability_id: NEW_CAPABILITY, description: '契約書をレビューする', capability_risk: 'low',
    }));

    const line = logLines(harness).find((entry) => entry.event === 'admin.permission_changed')!;
    expect(line.fields).toMatchObject({ action: 'create', capability_id: NEW_CAPABILITY, admin_principal: ADMIN_PRINCIPAL });
  });

  it('refuses an id that is not a capability id, and says why', async () => {
    const harness = await createAuthzHarness();

    const shape = await harness.asAdmin('/admin/permissions', json({
      capability_id: 'Contract.Review', description: 'x', capability_risk: 'low',
    }));
    // A vendor name in an id is what RULE-15 is about: a capability is not an API.
    const vendor = await harness.asAdmin('/admin/permissions', json({
      capability_id: 'google.calendar.read', description: 'x', capability_risk: 'low',
    }));

    expect([shape.status, vendor.status]).toEqual([400, 400]);
    expect(await taxonomyRow(harness, 'Contract.Review')).toBeUndefined();
    expect(await taxonomyRow(harness, 'google.calendar.read')).toBeUndefined();
  });

  it('reports every problem at once', () => {
    const parsed = parsePermission({ capability_id: '', description: '', capability_risk: 'extreme' });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.errors).toHaveLength(3);
  });

  it('refuses to create one that already exists rather than overwriting it', async () => {
    const harness = await createAuthzHarness();
    const response = await harness.asAdmin('/admin/permissions', json({
      capability_id: 'document.read', description: '書き換えられたら困る', capability_risk: 'high',
    }));

    expect(response.status).toBe(409);
    expect((await taxonomyRow(harness, 'document.read'))!.description).toBe('Read documents');
  });
});

describe('editing a permission', () => {
  it('changes what the taxonomy says and keeps the delegation policy id', async () => {
    const harness = await createAuthzHarness();

    const response = await harness.asAdmin('/admin/permissions/document.write', form({
      description: '書類を書く（改訂）', capability_risk: 'high', personal_data_access: 'on',
    }));

    expect(response.status).toBe(303);
    expect(await taxonomyRow(harness, 'document.write')).toMatchObject({
      description: '書類を書く（改訂）',
      default_characteristics: { capability_risk: 'high', personal_data_access: true, sensitive_resource: false },
    });
    // The seeded policy id survives, so a denial still names the policy an auditor can
    // look up rather than one this console invented.
    expect(await harness.documents.get(AUTHZ_COLLECTIONS.delegatablePermissions, 'document.write'))
      .toEqual({ capability_id: 'document.write', delegatable: false, policy_id: 'del-006' });
  });

  it('answers 404 for an id that does not exist', async () => {
    const harness = await createAuthzHarness();
    const response = await harness.asAdmin('/admin/permissions/nothing.here', json({ description: 'x', capability_risk: 'low' }));
    expect(response.status).toBe(404);
  });
});

describe('deleting a permission', () => {
  it('refuses while someone holds it or a resource is mapped to it', async () => {
    const harness = await createAuthzHarness();

    const response = await harness.asAdmin('/admin/permissions/document.read/delete', {
      method: 'POST', headers: JSON_HEADERS,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict' });
    expect(await taxonomyRow(harness, 'document.read')).toBeDefined();
  });

  it('removes both records once nothing points at it', async () => {
    const harness = await createAuthzHarness();
    await harness.asAdmin('/admin/permissions', json({
      capability_id: NEW_CAPABILITY, description: '契約書をレビューする', capability_risk: 'low',
    }));

    const response = await harness.asAdmin(`/admin/permissions/${NEW_CAPABILITY}/delete`, {
      method: 'POST', headers: JSON_HEADERS,
    });

    expect(response.status).toBe(200);
    expect(await taxonomyRow(harness, NEW_CAPABILITY)).toBeUndefined();
    expect(await harness.documents.get(AUTHZ_COLLECTIONS.delegatablePermissions, NEW_CAPABILITY)).toBeUndefined();
  });
});

/**
 * The point of the console: a permission created on it is a permission the platform
 * decides with, not a row in a table nothing reads.
 */
describe('a created permission reaches the Policy Engine', () => {
  it('is granted once it is delegatable, held, and mapped to a resource', async () => {
    const harness = await createAuthzHarness();
    await harness.asAdmin('/admin/permissions', json({
      capability_id: NEW_CAPABILITY, description: '契約書をレビューする', capability_risk: 'low', delegatable: true,
    }));
    await harness.foreign('seed').set(AUTHZ_COLLECTIONS.humanPermissions, `testuser__${NEW_CAPABILITY}`, {
      human_subject: 'testuser', capability_id: NEW_CAPABILITY, granted_at: '2026-03-01T00:00:00.000Z',
    });
    // The mapping itself belongs to the Provisioner's console (RULE-16); what this
    // spec needs is only that the row exists.
    await harness.foreign('provisioner').set(AUTHZ_COLLECTIONS.catalogTools, 'internal.document.list', {
      tool_id: 'internal.document.list', connector_id: 'internal-docs-api', required_capability: NEW_CAPABILITY,
    });

    const record = await runWith(harness, [NEW_CAPABILITY]);

    expect(record.effective_capabilities).toEqual([NEW_CAPABILITY]);
  });

  /**
   * org-002 denies a capability none of whose connectors is approved, and a capability
   * mapped to nothing has none at all. The screen says "未マッピング" for exactly this
   * reason: without the mapping step the permission exists and grants nothing.
   */
  it('is denied while no resource is mapped to it', async () => {
    const harness = await createAuthzHarness();
    await harness.asAdmin('/admin/permissions', json({
      capability_id: NEW_CAPABILITY, description: '契約書をレビューする', capability_risk: 'low', delegatable: true,
    }));
    await harness.foreign('seed').set(AUTHZ_COLLECTIONS.humanPermissions, `testuser__${NEW_CAPABILITY}`, {
      human_subject: 'testuser', capability_id: NEW_CAPABILITY, granted_at: '2026-03-01T00:00:00.000Z',
    });

    const record = await runWith(harness, [NEW_CAPABILITY]);

    expect(record.effective_capabilities).toEqual([]);
    expect(record.denied.map((denial) => denial.reason_code)).toEqual(['org_policy_denied']);
  });
});

/** One decision through the real pipeline, with the model proposing what is asked for. */
async function runWith(harness: AuthzHarness, capabilities: string[]) {
  return decide({
    humanSubject: 'testuser', purpose: '契約レビュー', description: '契約書を確認する',
    constraints: {}, requestedLifetimeMinutes: 480,
  }, {
    store: createAuthorizationStore(harness.documents),
    vertex: createFakeVertex({ capabilities }),
    clock: { now: () => Date.parse('2026-03-01T00:00:00Z') },
    modelVersion: testConfig.vertexModel,
    taxonomyVersion: testConfig.taxonomyVersion,
    logger: createLogger('authorization', 'policy_engine', () => {}),
  });
}
