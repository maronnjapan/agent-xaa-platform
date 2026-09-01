import { describe, expect, it } from 'vitest';
import { reevaluate, ReevaluationFailed } from '../src/reevaluate/reevaluate.js';
import { createReprovisionClient, ReprovisionRequestFailed } from '../src/reevaluate/reprovision-client.js';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import { createAuthzHarness, seedAgent, seedDecision, seedHumanPermissions } from './helpers.js';

const SUBJECT = 'user-456';
const CHANGE = { human_subject: SUBJECT, changed_at: '2026-03-02T09:00:00.000Z' };
const CLOCK = { now: () => Date.parse('2026-03-02T09:00:01.000Z') };

async function threeAgents(statuses: string[]) {
  const harness = await createAuthzHarness({ humanPermissions: [] });
  await seedHumanPermissions(harness, SUBJECT, ['document.read']);
  await seedDecision(harness, {
    decisionId: 'dec_seed-1', humanSubject: SUBJECT,
    proposed: ['document.read', 'finance.payment.approve'],
    effective: ['document.read', 'finance.payment.approve'],
    createdAt: '2026-03-01T00:00:00.000Z',
  });
  for (const [index, status] of statuses.entries()) {
    await seedAgent(harness, {
      agentId: `agent-${index}`, humanSubject: SUBJECT, status, createdAt: '2026-03-01T01:00:00.000Z',
    });
  }
  return harness;
}

describe('re-evaluation', () => {
  it('runs the Policy Engine once per agent it reaches', async () => {
    const harness = await threeAgents(['ACTIVE', 'EXPIRING', 'REVOKED']);
    const outcomes = await reevaluate(CHANGE, {
      store: createAuthorizationStore(harness.documents), clock: CLOCK,
      requestReprovision: async () => undefined,
    });

    expect(outcomes.map((outcome) => outcome.agent_id)).toEqual(['agent-0', 'agent-1']);
    const written = await harness.documents.queryEqual('authorization_decisions', [['source', 'permission_change']]);
    expect(written).toHaveLength(2);
    expect(harness.vertex.calls).toBe(0);
  });

  it('carries on with the other agents when one fails, then reports the failure', async () => {
    const harness = await threeAgents(['ACTIVE', 'ACTIVE']);
    let calls = 0;
    const run = reevaluate(CHANGE, {
      store: createAuthorizationStore(harness.documents), clock: CLOCK,
      requestReprovision: async () => {
        calls += 1;
        if (calls === 1) throw new Error('lifecycle unavailable');
      },
    });

    await expect(run).rejects.toBeInstanceOf(ReevaluationFailed);
    expect(calls).toBe(2);
    // The agent that succeeded keeps its new decision; the failure is not a rollback.
    const written = await harness.documents.queryEqual('authorization_decisions', [['source', 'permission_change']]);
    expect(written).toHaveLength(2);
  });

  it('reads the proposal back instead of proposing again', async () => {
    const harness = await threeAgents(['ACTIVE']);
    const store = createAuthorizationStore(harness.documents);
    const proposal = await store.getProposalByDecisionId('dec_seed-1');
    expect(proposal?.proposed_capabilities).toEqual(['document.read', 'finance.payment.approve']);
    expect(proposal).not.toHaveProperty('effective_capabilities');

    await reevaluate(CHANGE, { store, clock: CLOCK, requestReprovision: async () => undefined });
    expect(harness.vertex.calls).toBe(0);
  });
});

describe('the re-provisioning request', () => {
  function client(response: Response, seen: Array<{ url: string; init: RequestInit }>) {
    return createReprovisionClient({
      lifecycleBaseUrl: 'https://lifecycle.test',
      identityToken: async (audience) => `id-token-for:${audience}`,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return response;
      }) as unknown as typeof fetch,
    });
  }

  it('addresses the agent and carries a Google-issued token for Lifecycle', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    await client(new Response('{}', { status: 200 }), seen)({
      agentId: 'agent-01hxyz', effectiveCapabilities: ['document.read'],
      workDefinitionId: 'wd_1', reason: 'human_permission_revoked',
    });

    expect(seen[0]!.url).toBe('https://lifecycle.test/internal/agents/agent-01hxyz/reprovision');
    const headers = seen[0]!.init.headers as Record<string, string>;
    // The audience is the destination, so a token minted for one service cannot be
    // replayed against another.
    expect(headers.authorization).toBe('Bearer id-token-for:https://lifecycle.test');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      effective_capabilities: ['document.read'],
      required_capabilities: ['document.read'],
      work_definition_id: 'wd_1',
    });
  });

  it('fails loudly when Lifecycle refuses the caller', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const call = client(new Response('{"error":"caller_not_allowed"}', { status: 403 }), seen)({
      agentId: 'agent-1', effectiveCapabilities: [], workDefinitionId: 'wd_1', reason: 'human_permission_revoked',
    });
    await expect(call).rejects.toBeInstanceOf(ReprovisionRequestFailed);
  });
});
