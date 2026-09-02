import { describe, expect, it, vi } from 'vitest';
import { createFirestoreDouble } from '@xaa/gcp';
import { createLifecycleHarness, seedDomain } from '@xaa/lifecycle-manager/src/testing/harness';
import { automationIdpPublicJwk, startAutomationAppHarness } from '../../harness/automation-app.js';

/**
 * REQ-02-023. The stop button, wired to the app that actually destroys an agent.
 *
 * Both halves are the real thing: the Automation App builds the request and the DPoP
 * proof, and the Lifecycle Manager verifies the token, the proof and the ownership
 * before it revokes anything. That is the point of running them together — the two
 * bugs this catches (a path the Lifecycle Manager does not serve, and a proof whose
 * `htu` disagrees with the request line) both look like an authorisation failure from
 * either side alone.
 *
 * RULE-27 / RULE-41: the Automation App cancels no Job and destroys no key. Everything
 * that ends an agent's life is recorded here as a call the Lifecycle Manager made.
 */
describe('stopping an agent from the screen', () => {
  it('delegates to the Lifecycle Manager, which destroys the agent', async () => {
    const shared = createFirestoreDouble();
    const lifecycle = createLifecycleHarness({ shared, idpPublicJwk: await automationIdpPublicJwk() });
    const agentId = await seedDomain(lifecycle, { humanSubject: 'testuser' });
    const automation = await startAutomationAppHarness({
      shared,
      upstream: (url, init) => lifecycle.fetch(new URL(url).pathname, init),
    });

    const response = await automation.fetch(`/api/agents/${agentId}/stop`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'stopping' });
    const call = automation.upstream.at(-1)!;
    expect(call.url).toBe(`https://lifecycle.test/agents/${agentId}/revoke`);
    expect((call.init.headers as Record<string, string>).DPoP).toBeTruthy();

    // Cleanup is started after the 202 is answered, so the terminal state arrives a
    // moment later. It is waited for, never slept for.
    await vi.waitFor(async () => {
      expect(await lifecycle.provisionerStore.get('agents', `${agentId}__meta`)).toBeUndefined();
    });

    // What DESTROYED consists of, all of it done by the Lifecycle Manager.
    const targets = lifecycle.clients.calls.map((entry) => entry.target);
    expect(targets).toContain('cancelExecution');
    expect(targets).toContain('disableIssuance');
    expect(targets).toContain('deleteRegistration');
    // The Automation App made none of these calls itself: its only outbound request in
    // the whole exchange was the revoke.
    expect(automation.upstream.map((entry) => entry.url))
      .toEqual([`https://lifecycle.test/agents/${agentId}/revoke`]);
    // The Lifecycle Manager's own record of who asked and what it decided.
    const audited = lifecycle.auditLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audited).toContainEqual(expect.objectContaining({
      operation: 'agent.revoke', agentId, actor: 'testuser', result: 'accepted',
    }));

    // And nothing is left to stop: the second press finds no agent at all.
    expect((await automation.fetch(`/api/agents/${agentId}/stop`, { method: 'POST' })).status).toBe(404);
  });

  it("refuses to stop somebody else's agent without saying it exists", async () => {
    const shared = createFirestoreDouble();
    const lifecycle = createLifecycleHarness({ shared, idpPublicJwk: await automationIdpPublicJwk() });
    const agentId = await seedDomain(lifecycle, { humanSubject: 'someone-else' });
    const automation = await startAutomationAppHarness({
      shared,
      upstream: (url, init) => lifecycle.fetch(new URL(url).pathname, init),
    });

    const response = await automation.fetch(`/api/agents/${agentId}/stop`, { method: 'POST' });

    // 404 from the screen, and the Lifecycle Manager was never asked (RULE-56).
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(automation.upstream).toHaveLength(0);
    expect(await lifecycle.provisionerStore.get('agents', `${agentId}__meta`)).toBeDefined();
  });
});
