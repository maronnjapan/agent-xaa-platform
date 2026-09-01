import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { reprovisionBodySchema } from '../src/routes/reprovision.js';
import { createProvisionerHarness, seedDecision, type ProvisionerHarness } from './helpers.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;

const PATH = '/internal/provisioning/reprovision';

async function body(target: ProvisionerHarness, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  // The permissions have to exist for the person: a replacement is refused, not
  // narrowed, when the caller names something they no longer hold.
  await seedDecision(target, { capabilities: ['document.read'], humanSubject: 'testuser' });
  return {
    work_definition_id: 'work-1',
    human_subject: 'testuser',
    effective_capabilities: ['document.read'],
    isolation_level: 'standard',
    inherited_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    previous_agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    ...overrides,
  };
}

function post(target: ProvisionerHarness, payload: unknown, token = 'lifecycle-token'): Promise<Response> {
  return target.fetch(PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

/**
 * The two ends of one call. The Provisioner's route and Lifecycle's client were written
 * apart, and nothing but this compares them — which is how the route came to be missing
 * while every test on both sides stayed green.
 */
describe('the contract with the Lifecycle Manager', () => {
  it('serves the path that Lifecycle posts to', async () => {
    const client = await readFile(`${repoRoot}apps/lifecycle-manager/src/clients/http.ts`, 'utf8');
    expect(client).toContain(`'${PATH}'`);
  });

  it('requires exactly the keys Lifecycle sends', async () => {
    const source = await readFile(`${repoRoot}apps/lifecycle-manager/src/reprovision.ts`, 'utf8');
    const listed = source.slice(source.indexOf('REPROVISION_BODY_KEYS'), source.indexOf('] as const'));
    const sent = [...listed.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect([...reprovisionBodySchema.required].sort()).toEqual([...sent].sort());
  });

  it('accepts the body Lifecycle builds and answers with the new agent id', async () => {
    const target = await createProvisionerHarness();
    const response = await post(target, await body(target));
    expect(response.status).toBe(201);
    const answer = await response.json() as { agent_id: string; expires_at: string };
    expect(answer.agent_id).toMatch(/^agent-[0-9a-z]{26}$/);
    expect(target.jobRuns).toHaveLength(1);
  });
});

describe('POST /internal/provisioning/reprovision', () => {
  it('refuses a caller that is not sa-lifecycle', async () => {
    const target = await createProvisionerHarness();
    const response = await post(target, await body(target), 'someone-else');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'caller_not_allowed' });
    expect(target.jobRuns).toHaveLength(0);
  });

  it('refuses a request with no token at all', async () => {
    const target = await createProvisionerHarness();
    const response = await target.fetch(PATH, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await body(target)),
    });
    expect(response.status).toBe(403);
  });

  it('refuses a body with an unexpected field', async () => {
    const target = await createProvisionerHarness();
    const response = await post(target, { ...await body(target), decision_id: 'dec_x' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });

  it('inherits the expiry instead of granting a fresh lifetime', async () => {
    const target = await createProvisionerHarness();
    const expiresAt = new Date(Date.now() + 1_800_000).toISOString();
    const response = await post(target, await body(target, { inherited_expires_at: expiresAt }));
    const answer = await response.json() as { agent_id: string; expires_at: string };
    expect(answer.expires_at).toBe(expiresAt);
    const registration = await target.documents.get<{ expires_at: string }>('agents', `${answer.agent_id}__meta`);
    expect(registration!.expires_at).toBe(expiresAt);
  });

  it('refuses an expiry that has already passed', async () => {
    const target = await createProvisionerHarness();
    const response = await post(target, await body(target, {
      inherited_expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    expect(response.status).toBe(400);
    expect(target.jobRuns).toHaveLength(0);
  });

  it('joins the new agent to the one it replaces on the timeline', async () => {
    const target = await createProvisionerHarness();
    const previous = 'agent-abcdefghijklmnopqrstuvwxyz';
    await post(target, await body(target, { previous_agent_id: previous }));
    const started = target.activity[0]!;
    expect((started.detail as { replaces_agent_id?: string }).replaces_agent_id).toBe(previous);
  });

  it('refuses a capability the person does not hold, however the caller asks', async () => {
    const target = await createProvisionerHarness();
    const response = await post(target, await body(target, {
      effective_capabilities: ['document.read', 'finance.payment.approve'],
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'capability_not_subset_of_human_permission', capabilities: ['finance.payment.approve'],
    });
  });
});
