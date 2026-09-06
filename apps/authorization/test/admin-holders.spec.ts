import { describe, expect, it } from 'vitest';
import { AUTHZ_COLLECTIONS, humanPermissionId } from '../src/store/collections.js';
import { ADMIN_ROUTES } from '../src/routes/index.js';
import {
  ADMIN_PRINCIPAL, createAuthzHarness, logLines, seedAgent, seedDecision, seedHumanPermissions, type AuthzHarness,
} from './helpers.js';

const SUBJECT = 'user-456';
const HOLDER_PATH = '/admin/holders';
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

function json(values: Record<string, unknown>): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(values) };
}

function form(values: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  };
}

async function grantRow(harness: AuthzHarness, capabilityId: string): Promise<Record<string, unknown> | undefined> {
  return harness.documents.get(AUTHZ_COLLECTIONS.humanPermissions, humanPermissionId(SUBJECT, capabilityId));
}

/** One person with a decided, running agent, so a change has somebody to reach. */
async function withRunningAgent(): Promise<AuthzHarness> {
  const harness = await createAuthzHarness({ humanPermissions: [] });
  await seedHumanPermissions(harness, SUBJECT, ['document.read', 'finance.payment.approve']);
  await seedDecision(harness, {
    decisionId: 'dec_seed-1', humanSubject: SUBJECT,
    proposed: ['document.read', 'finance.payment.approve'],
    effective: ['document.read', 'finance.payment.approve'],
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  await seedAgent(harness, {
    agentId: 'agent-0', humanSubject: SUBJECT, status: 'ACTIVE', createdAt: '2026-03-01T01:00:00.000Z',
  });
  return harness;
}

describe('the holder screen is reachable only by an administrator', () => {
  it('refuses a request with no token and one from an unlisted account', async () => {
    const harness = await createAuthzHarness();

    const anonymous = await harness.fetch(`${HOLDER_PATH}?human_subject=${SUBJECT}`, { headers: { accept: 'application/json' } });
    const stranger = await harness.asAdmin(HOLDER_PATH, {
      headers: { accept: 'application/json' }, principal: 'sa-automation-app@xaa-test.iam.gserviceaccount.com',
    });

    expect(anonymous.status).toBe(403);
    expect(stranger.status).toBe(403);
    expect(await anonymous.json()).toEqual({ error: 'admin_only' });
  });

  it('is named in the console route table, which is separate from the decision surface', () => {
    expect(ADMIN_ROUTES.some((route) => route.method === 'POST' && route.path === HOLDER_PATH)).toBe(true);
    expect(ADMIN_ROUTES.every((route) => route.path.startsWith('/admin'))).toBe(true);
  });
});

describe('the holder list', () => {
  it('shows every capability with whether this person holds it', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    await seedHumanPermissions(harness, SUBJECT, ['document.read']);

    const response = await harness.asAdmin(`${HOLDER_PATH}?human_subject=${SUBJECT}`, { headers: { accept: 'application/json' } });
    const body = await response.json() as { human_subject: string; permissions: Array<{ capability_id: string; held: boolean; delegatable: boolean }> };

    expect(response.status).toBe(200);
    expect(body.human_subject).toBe(SUBJECT);
    expect(body.permissions.find((entry) => entry.capability_id === 'document.read')).toMatchObject({ held: true, delegatable: true });
    expect(body.permissions.find((entry) => entry.capability_id === 'calendar.event.write')).toMatchObject({ held: false });
  });

  /**
   * A permission is granted to a person, and every question asked here is asked about
   * one person. Listing everybody would answer none of them and would print the whole
   * membership of every capability to whoever opened the page.
   */
  it('asks who, rather than listing everyone', async () => {
    const harness = await createAuthzHarness();
    const html = await (await harness.asAdmin(HOLDER_PATH, { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('human_subject');
    expect(html).not.toContain('document.read');
  });

  it('renders one person as a page a browser can use', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    await seedHumanPermissions(harness, SUBJECT, ['document.read']);
    const response = await harness.asAdmin(`${HOLDER_PATH}?human_subject=${SUBJECT}`, { headers: { accept: 'text/html' } });
    const html = await response.text();

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('document.read');
    expect(html).toContain('取り上げる');
  });
});

describe('granting and revoking one person\'s permission', () => {
  it('writes the grant row and sends a browser back to that person', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });

    const response = await harness.asAdmin(HOLDER_PATH, form({
      human_subject: SUBJECT, capability_id: 'document.read', action: 'grant',
    }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${HOLDER_PATH}?human_subject=${SUBJECT}`);
    expect(await grantRow(harness, 'document.read')).toMatchObject({
      human_subject: SUBJECT, capability_id: 'document.read',
    });
  });

  /**
   * `human_permissions` is one row per (subject, capability) precisely so that losing a
   * permission is the absence of a record rather than a flag some reader could forget.
   */
  it('revokes by removing the row, not by flagging it', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    await seedHumanPermissions(harness, SUBJECT, ['document.read']);

    const response = await harness.asAdmin(HOLDER_PATH, json({
      human_subject: SUBJECT, capability_id: 'document.read', action: 'revoke',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'revoked' });
    expect(await grantRow(harness, 'document.read')).toBeUndefined();
  });

  /**
   * RULE-14: a revocation has to reach the agents already running on that permission,
   * or the platform believes two things about what an agent may do.
   */
  it('re-evaluates the running agents of the person whose permission narrowed', async () => {
    const harness = await withRunningAgent();

    const response = await harness.asAdmin(HOLDER_PATH, json({
      human_subject: SUBJECT, capability_id: 'finance.payment.approve', action: 'revoke',
    }));

    expect(await response.json()).toMatchObject({ agents_reevaluated: 1 });
    // The deterministic half re-runs and the model is not asked again: re-proposing
    // could return a different set for the same work, which would make a revocation
    // look like a re-scoping.
    expect(harness.vertex.calls).toBe(0);
    const rewritten = await harness.documents.queryEqual<{ effective_capabilities: string[] }>(
      AUTHZ_COLLECTIONS.authorizationDecisions, [['source', 'permission_change']],
    );
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]!.data.effective_capabilities).toEqual(['document.read']);
  });

  it('spends no re-evaluation on a change that moved nothing', async () => {
    const harness = await withRunningAgent();

    const response = await harness.asAdmin(HOLDER_PATH, json({
      human_subject: SUBJECT, capability_id: 'document.read', action: 'grant',
    }));

    expect(await response.json()).toMatchObject({ result: 'unchanged', agents_reevaluated: 0 });
    expect(await harness.documents.queryEqual(
      AUTHZ_COLLECTIONS.authorizationDecisions, [['source', 'permission_change']],
    )).toHaveLength(0);
  });

  it('refuses a capability the taxonomy does not have, writing nothing', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });

    const response = await harness.asAdmin(HOLDER_PATH, json({
      human_subject: SUBJECT, capability_id: 'contract.review', action: 'grant',
    }));

    expect(response.status).toBe(400);
    expect(await grantRow(harness, 'contract.review')).toBeUndefined();
  });

  it('reports every problem at once rather than the first', async () => {
    const harness = await createAuthzHarness();
    const response = await harness.asAdmin(HOLDER_PATH, json({ capability_id: 'Not A Capability', action: 'delete' }));

    expect(response.status).toBe(400);
    const body = await response.json() as { details: string[] };
    expect(body.details).toHaveLength(3);
  });

  it('records who made the change and whose permissions moved', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    await harness.asAdmin(HOLDER_PATH, json({ human_subject: SUBJECT, capability_id: 'document.read', action: 'grant' }));

    const line = logLines(harness).find((entry) => entry.event === 'admin.holder_changed')!;
    expect(line.fields).toMatchObject({
      action: 'grant', capability_id: 'document.read', result: 'granted', admin_principal: ADMIN_PRINCIPAL,
    });
  });
});
