import { describe, expect, it } from 'vitest';
import {
  createAuthzHarness, logLines, pushBody, revokeHumanPermission, seedAgent, seedDecision, seedHumanPermissions,
  type AuthzHarness,
} from './helpers.js';

const ROUTE = '/internal/events/human-permission-changed';
const SUBJECT = 'user-456';
const CHANGED_AT = '2026-03-02T09:00:00.000Z';

async function decisionsOf(harness: AuthzHarness, source: string): Promise<Array<{ effective_capabilities: string[]; agent_id?: string }>> {
  const rows = await harness.documents.queryEqual<{ effective_capabilities: string[]; agent_id?: string; source?: string }>(
    'authorization_decisions', [['source', source]],
  );
  return rows.map(({ data }) => data);
}

/**
 * One person with two capabilities, one running agent that was decided on both, and
 * a revocation of one of them.
 */
async function shrinkFixture(options: { statuses?: string[]; reprovisionFails?: boolean } = {}) {
  const harness = await createAuthzHarness({
    humanPermissions: [],
    ...(options.reprovisionFails ? { reprovisionFails: true } : {}),
  });
  await seedHumanPermissions(harness, SUBJECT, ['document.read', 'finance.payment.approve']);
  await seedDecision(harness, {
    decisionId: 'dec_seed-1', humanSubject: SUBJECT,
    proposed: ['document.read', 'finance.payment.approve'],
    effective: ['document.read', 'finance.payment.approve'],
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  const statuses = options.statuses ?? ['ACTIVE'];
  for (const [index, status] of statuses.entries()) {
    await seedAgent(harness, {
      agentId: `agent-${index}`, humanSubject: SUBJECT, status, createdAt: '2026-03-01T01:00:00.000Z',
    });
  }
  await revokeHumanPermission(harness, SUBJECT, 'finance.payment.approve');
  return harness;
}

describe('the human-permission-changed receiver', () => {
  it('requires the subject and the moment, and accepts the change itself as optional', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });

    expect((await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT }))).status).toBe(400);
    expect((await harness.fetch(ROUTE, pushBody({ changed_at: CHANGED_AT }))).status).toBe(400);
    expect((await harness.fetch(ROUTE, pushBody({
      human_subject: SUBJECT, changed_at: CHANGED_AT, capability_id: 'document.read', action: 'revoke',
    }))).status).toBe(204);
  });

  it('refuses a change carrying a field the contract does not define', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    const response = await harness.fetch(ROUTE, pushBody({
      human_subject: SUBJECT, changed_at: CHANGED_AT, effective_capabilities: ['document.read'],
    }));
    expect(response.status).toBe(400);
  });

  it('answers 204 with no body even when the person has no agents', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    const response = await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('re-decides without asking the model again', async () => {
    const harness = await shrinkFixture();
    await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT, action: 'revoke' }));

    expect(harness.vertex.calls).toBe(0);
    const rewritten = await decisionsOf(harness, 'permission_change');
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]!.effective_capabilities).toEqual(['document.read']);
  });

  it('reaches ACTIVE and EXPIRING agents, and no others', async () => {
    const harness = await createAuthzHarness({ humanPermissions: [] });
    await seedHumanPermissions(harness, SUBJECT, ['document.read']);
    await seedHumanPermissions(harness, 'someone-else', ['document.read', 'finance.payment.approve']);
    await seedDecision(harness, {
      decisionId: 'dec_seed-1', humanSubject: SUBJECT,
      proposed: ['document.read'], effective: ['document.read'], createdAt: '2026-03-01T00:00:00.000Z',
    });
    await seedDecision(harness, {
      decisionId: 'dec_other', humanSubject: 'someone-else',
      proposed: ['document.read'], effective: ['document.read'], createdAt: '2026-03-01T00:00:00.000Z',
    });
    const createdAt = '2026-03-01T01:00:00.000Z';
    await seedAgent(harness, { agentId: 'agent-active', humanSubject: SUBJECT, status: 'ACTIVE', createdAt });
    await seedAgent(harness, { agentId: 'agent-expiring', humanSubject: SUBJECT, status: 'EXPIRING', createdAt });
    await seedAgent(harness, { agentId: 'agent-expired', humanSubject: SUBJECT, status: 'EXPIRED', createdAt });
    await seedAgent(harness, { agentId: 'agent-destroyed', humanSubject: SUBJECT, status: 'DESTROYED', createdAt });
    await seedAgent(harness, { agentId: 'agent-foreign', humanSubject: 'someone-else', status: 'ACTIVE', createdAt });

    await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT }));

    const touched = (await decisionsOf(harness, 'permission_change')).map((decision) => decision.agent_id);
    expect(touched.sort()).toEqual(['agent-active', 'agent-expiring']);
  });

  it('processes a redelivery once, whatever Pub/Sub does', async () => {
    const harness = await shrinkFixture();
    const message = pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT, action: 'revoke' });

    const first = await harness.fetch(ROUTE, message);
    const second = await harness.fetch(ROUTE, message);

    expect([first.status, second.status]).toEqual([204, 204]);
    expect(await decisionsOf(harness, 'permission_change')).toHaveLength(1);
    expect(harness.reprovisions).toHaveLength(1);
    const duplicates = logLines(harness).filter((line) => line.fields.delivery === 'duplicate');
    expect(duplicates).toHaveLength(1);
  });

  it('treats a different moment as a different change', async () => {
    const harness = await shrinkFixture();
    await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT }));
    await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: '2026-03-02T10:00:00.000Z' }));
    expect(await decisionsOf(harness, 'permission_change')).toHaveLength(2);
  });

  it('leaves the decision the agent was created under untouched', async () => {
    const harness = await shrinkFixture();
    await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT }));
    const original = await harness.documents.get<{ effective_capabilities: string[] }>('authorization_decisions', 'dec_seed-1');
    expect(original?.effective_capabilities).toEqual(['document.read', 'finance.payment.approve']);
  });

  it('reports a failed re-evaluation so Pub/Sub delivers it again', async () => {
    const harness = await shrinkFixture({ reprovisionFails: true });
    const response = await harness.fetch(ROUTE, pushBody({ human_subject: SUBJECT, changed_at: CHANGED_AT }));
    expect(response.status).toBe(500);
  });
});
