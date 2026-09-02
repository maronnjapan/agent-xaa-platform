import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@xaa/logging';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { provisionAgent } from '../src/provisioning/flow.js';
import { createProvisionerHarness, seedDecision, type ProvisionerHarness } from './helpers.js';

/**
 * RULE-26 / REQ-07-018. An agent's lifetime is not the Cloud Run task timeout.
 *
 * The timeout ends the process. It does not end the delegation: an IdP connection that
 * outlived the agent would still exchange a refresh token, and a registration that
 * outlived it would still be accepted by the Agent OP. So the same expiry is carried
 * into every layer that can independently refuse — and carried as the same string,
 * because that is how the comparison is made downstream.
 *
 * One value, computed once and passed. Recomputing it per call site is how two of them
 * end up a second apart, which is invisible until the day it decides an exchange.
 */
async function run(target: ProvisionerHarness, options: {
  createIdpConnection?: ProvisionerHarness['deps']['agentOp']['createIdpConnection'];
} = {}) {
  await seedDecision(target, { capabilities: ['document.read'] });
  return provisionAgent({
    ...target.deps,
    logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
    catalogue: createCatalogRepository(target.documents),
    ...(options.createIdpConnection
      ? { agentOp: { ...target.deps.agentOp, createIdpConnection: options.createIdpConnection } }
      : {}),
  }, {
    humanSubject: 'testuser', taskId: 't', effectiveCapabilities: ['document.read'],
    isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', hours: 8 },
  });
}

describe('the one expiry every layer is given', () => {
  it('hands the registration, the IdP connection and the execution the same string', async () => {
    const target = await createProvisionerHarness();
    const connectionRequests: Array<{ agentId: string; expiresAt: string }> = [];
    const outcome = await run(target, {
      async createIdpConnection(input) {
        connectionRequests.push({ agentId: input.agentId, expiresAt: input.expiresAt });
        return { status: 'READY', consentUrl: '' };
      },
    });
    expect(outcome.status).toBe(201);
    const agentId = (outcome.body as { agent_id: string }).agent_id;

    const registration = (await target.documents.get<{ expires_at: string }>('agents', `${agentId}__meta`))!;
    const jobEnvironment = Object.fromEntries(target.jobRuns[0]!.env.map((entry) => [entry.name, entry.value]));
    const manifest = JSON.parse(jobEnvironment.TOOL_MANIFEST!) as { expires_at: string };

    expect(connectionRequests).toHaveLength(1);
    expect(connectionRequests[0]!.agentId).toBe(agentId);
    // Compared as strings, not as instants: the Agent OP stores what it was sent, and
    // a value that differs only in precision differs when it is read back.
    expect(connectionRequests[0]!.expiresAt).toBe(registration.expires_at);
    expect(jobEnvironment.AGENT_EXPIRES_AT).toBe(registration.expires_at);
    expect(manifest.expires_at).toBe(registration.expires_at);
    expect(registration.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('records the same expiry in the completion log', async () => {
    const target = await createProvisionerHarness();
    const outcome = await run(target);
    const agentId = (outcome.body as { agent_id: string }).agent_id;
    const registration = (await target.documents.get<{ expires_at: string }>('agents', `${agentId}__meta`))!;
    const line = target.logs.map((entry) => JSON.parse(entry) as { fields: Record<string, unknown> })
      .find((entry) => entry.fields.event === 'provisioning_completed')!;
    expect(line.fields.expires_at).toBe(registration.expires_at);
  });

  /**
   * The Agent OP refuses a connection whose expiry is further out than a day (that
   * check is T-OP's). What belongs here is what the Provisioner does with the refusal:
   * fail the transaction rather than carry on and register an agent whose delegation
   * layer never accepted it.
   */
  it('fails the transaction when the Agent OP refuses the expiry', async () => {
    const target = await createProvisionerHarness();
    const outcome = await run(target, {
      async createIdpConnection() { throw new Error('agent OP call failed: 400'); },
    });
    expect(outcome.status).toBe(500);

    const transactions = await target.documents.listAll<{ status: string; pending_step: string }>('provisioning_transactions');
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.data.status).toBe('FAILED');
    expect(transactions[0]!.data.pending_step).toBe('idp_consent');
    expect((await target.documents.listAll('agents')).filter((row) => row.id.endsWith('__meta'))).toEqual([]);
    expect(target.jobRuns).toHaveLength(0);
  });

  /**
   * The Bridge's Connection is per person, not per agent: it is the person's link to a
   * SaaS account and outlives every agent that borrows it. Writing an agent's expiry
   * onto it would end that link when the agent ended. The Provisioner therefore has no
   * path to it at all — only to the per-agent Binding, which the Bridge owns.
   */
  it('never writes to a Bridge Connection', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = await readFile(full, 'utf8');
        if (/\.(set|update|create|delete)\(\s*['"]bridge_connections['"]/.test(text)) offenders.push(full);
        if (/\.(set|update|create|delete)\(\s*['"]connector_connections['"]/.test(text)) offenders.push(full);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});
