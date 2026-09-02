import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createLogger } from '@xaa/logging';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { provisionAgent } from '../src/provisioning/flow.js';
import { createAgentOpClient } from '../src/agent/idp-connection.js';
import { createProvisionerHarness, seedDecision } from './helpers.js';

/**
 * RULE-51. The refresh token behind a delegation is held by the Agent OP and by
 * nothing else.
 *
 * The Provisioner asks for a connection and asks whether it is ready. It never sees
 * the authorization code, never calls Human IdP's token endpoint and never holds a
 * refresh token — not even briefly. "Briefly" is the whole point: a service that holds
 * one for a second is a service whose logs, heap dumps and crash reports can contain
 * one, and the single-holder property is what makes revoking a connection sufficient.
 *
 * The call is service-to-service over Cloud Run's internal address with the caller's
 * own Google-issued ID Token. There is no browser leg here; the browser leg belongs to
 * the Agent OP's `/xaa/callback`.
 */
describe('asking the Agent OP for an IdP connection', () => {
  function recorder(response: unknown) {
    const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
      });
      return Response.json(response);
    }) as unknown as typeof fetch;
    const client = createAgentOpClient({
      baseUrl: 'https://shared-agent-op.test',
      // Cloud Run mints this from the metadata server for the target origin; what
      // matters here is that whatever it returns ends up on the request.
      identityToken: async (audience) => `id-token-for-${audience}`,
      fetchImpl,
    });
    return { calls, client };
  }

  it('posts to the internal address with the service account ID token on it', async () => {
    const { calls, client } = recorder({ status: 'CONSENT_REQUIRED', consentUrl: 'https://human-idp.test/authorize' });
    const result = await client.createIdpConnection({
      agentId: 'agent-abcdefghijklmnopqrstuvwxyz', humanSubject: 'testuser',
      idpConnectionId: 'idpconn-agent-abcdefghijklmnopqrstuvwxyz',
      expiresAt: '2026-03-01T08:00:00Z', transactionId: 'txn_aaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.status).toBe('CONSENT_REQUIRED');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    // The internal Cloud Run address, not a public one: the invoker check at the edge
    // is what makes the service account on the token mean anything.
    expect(calls[0]!.url).toBe('https://shared-agent-op.test/internal/idp-connections');
    expect(calls[0]!.authorization).toBe('Bearer id-token-for-https://shared-agent-op.test');
    expect(calls[0]!.body).toMatchObject({
      agentId: 'agent-abcdefghijklmnopqrstuvwxyz', humanSubject: 'testuser',
      expiresAt: '2026-03-01T08:00:00Z',
    });
  });

  it('asks about and revokes a connection over the same authenticated channel', async () => {
    const verify = recorder({ status: 'READY' });
    expect(await verify.client.verifyIdpConnection('idpconn-agent-abcdefghijklmnopqrstuvwxyz'))
      .toEqual({ status: 'READY' });
    expect(verify.calls[0]!.url)
      .toBe('https://shared-agent-op.test/internal/idp-connections/idpconn-agent-abcdefghijklmnopqrstuvwxyz/verify');
    expect(verify.calls[0]!.authorization).toMatch(/^Bearer /);

    const revoke = recorder({});
    await revoke.client.revokeIdpConnection!('idpconn-agent-abcdefghijklmnopqrstuvwxyz');
    expect(revoke.calls[0]!.url)
      .toBe('https://shared-agent-op.test/internal/idp-connections/idpconn-agent-abcdefghijklmnopqrstuvwxyz/revoke');
    expect(revoke.calls[0]!.authorization).toMatch(/^Bearer /);
  });

  it('treats a refusal from the Agent OP as a failure rather than a connection', async () => {
    const client = createAgentOpClient({
      baseUrl: 'https://shared-agent-op.test',
      identityToken: async () => 'id-token',
      fetchImpl: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
    });
    await expect(client.verifyIdpConnection('idpconn-x')).rejects.toThrow(/403/);
  });

  it('names no refresh token in any signature it exposes', async () => {
    for (const file of ['../src/agent/identity.ts', '../src/provisioning/flow.ts', '../src/deps.ts', '../src/runtime.ts']) {
      const text = await readFile(new URL(file, import.meta.url).pathname, 'utf8');
      expect(text).not.toMatch(/refresh_token|refreshToken/);
    }
  });

  it('goes no further when the connection is not READY', async () => {
    const target = await createProvisionerHarness({ verifyStatus: 'PENDING' });
    await seedDecision(target, { capabilities: ['document.read'] });
    const outcome = await provisionAgent({
      ...target.deps,
      logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
      catalogue: createCatalogRepository(target.documents),
    }, {
      humanSubject: 'testuser', taskId: 't', effectiveCapabilities: ['document.read'],
      isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', hours: 8 },
    });

    // 409 rather than a retry: the connection is the delegation, and every later step
    // would be building an agent on a delegation that does not exist yet.
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ error: 'precondition_failed', expected_step: 'verify_idp_connection' });
    expect((await target.documents.listAll('agents')).filter((row) => row.id.endsWith('__meta'))).toEqual([]);
    expect(target.jobRuns).toHaveLength(0);
  });

  it('verifies the connection even when it was created READY', async () => {
    const seen: string[] = [];
    const target = await createProvisionerHarness();
    await seedDecision(target, { capabilities: ['document.read'] });
    const outcome = await provisionAgent({
      ...target.deps,
      logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
      catalogue: createCatalogRepository(target.documents),
      agentOp: {
        ...target.deps.agentOp,
        async createIdpConnection() { seen.push('create'); return { status: 'READY' as const, consentUrl: '' }; },
        async verifyIdpConnection() { seen.push('verify'); return { status: 'READY' }; },
      },
    }, {
      humanSubject: 'testuser', taskId: 't', effectiveCapabilities: ['document.read'],
      isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', hours: 8 },
    });
    expect(outcome.status).toBe(201);
    // The creating call says the request was accepted; only the verify says the refresh
    // token behind it works now. A create that answers READY is not a substitute.
    expect(seen).toEqual(['create', 'verify']);
  });
});
