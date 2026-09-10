import { describe, expect, it } from 'vitest';
import { createLogger } from '@xaa/logging';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { provisionAgent } from '../src/provisioning/flow.js';
import { loadConfig } from '../src/runtime.js';
import { createProvisionerHarness, seedDecision, type ProvisionerHarness } from './helpers.js';

const CAPABILITIES = ['finance.payment.approve'];

async function provision(target: ProvisionerHarness, taskId: string) {
  await seedDecision(target, { capabilities: CAPABILITIES, isolationLevel: 'full_isolation' });
  return provisionAgent({
    ...target.deps,
    logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
    catalogue: createCatalogRepository(target.documents),
  }, {
    humanSubject: 'testuser',
    taskId,
    effectiveCapabilities: CAPABILITIES,
    isolationLevel: 'full_isolation',
    constraints: {},
    lifetime: { kind: 'requested', minutes: 480 },
  });
}

describe('the FULL_ISOLATION cap', () => {
  it('lets no more than the cap through, however many arrive at once', async () => {
    const target = await createProvisionerHarness({ config: { maxFullIsolationAgents: 2 } });
    // The reservation is what has to serialise these, not the order they happen to
    // reach Firestore in: three requests that each read "one slot left" and each take
    // it are exactly the failure this gate exists to prevent.
    const outcomes = await Promise.all([
      provision(target, 'a'), provision(target, 'b'), provision(target, 'c'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 201)).toHaveLength(2);
    const refused = outcomes.filter((outcome) => outcome.status === 503);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body).toMatchObject({ error: 'full_isolation_capacity_reached', capacity: 2 });
    expect(target.jobRuns).toHaveLength(2);
  });

  it('counts an agent that is still being provisioned, not only a finished one', async () => {
    const target = await createProvisionerHarness({ config: { maxFullIsolationAgents: 1 } });
    // The job never starts, so this agent never becomes ACTIVE — but its dedicated
    // service accounts exist, and those are what the cap is about.
    await seedDecision(target, { capabilities: CAPABILITIES, isolationLevel: 'full_isolation' });
    const failed = await provisionAgent({
      ...target.deps,
      jobs: { async runJob() { throw new Error('cloud run refused'); } },
      logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
      catalogue: createCatalogRepository(target.documents),
    }, {
      humanSubject: 'testuser', taskId: 'a', effectiveCapabilities: CAPABILITIES,
      isolationLevel: 'full_isolation', constraints: {}, lifetime: { kind: 'requested', minutes: 480 },
    });
    expect(failed.status).toBe(500);

    const second = await provision(target, 'b');
    expect(second.status).toBe(503);
  });

  it('gives the slot back once Lifecycle has released the resources', async () => {
    const target = await createProvisionerHarness({ config: { maxFullIsolationAgents: 1 } });
    const first = await provision(target, 'a');
    expect(first.status).toBe(201);
    expect((await provision(target, 'b')).status).toBe(503);

    const agentId = (first.body as { agent_id: string }).agent_id;
    await target.documents.update('dedicated_resources', agentId, { status: 'RELEASED' });

    expect((await provision(target, 'c')).status).toBe(201);
  });

  it('writes neither a transaction nor a ledger when it refuses', async () => {
    const target = await createProvisionerHarness({ config: { maxFullIsolationAgents: 1 } });
    await provision(target, 'a');
    const before = {
      transactions: (await target.documents.listAll('provisioning_transactions')).length,
      ledgers: (await target.documents.listAll('dedicated_resources')).length,
    };
    expect((await provision(target, 'b')).status).toBe(503);
    expect((await target.documents.listAll('provisioning_transactions')).length).toBe(before.transactions);
    expect((await target.documents.listAll('dedicated_resources')).length).toBe(before.ledgers);
  });

  it('reports reaching the cap in the structured log and in no Activity Event', async () => {
    const target = await createProvisionerHarness({ config: { maxFullIsolationAgents: 1 } });
    await provision(target, 'a');
    target.activity.length = 0;
    await provision(target, 'b');
    expect(target.logs.join('\n')).toContain('full_isolation_capacity_reached');
    expect(target.activity).toEqual([]);
  });

  it('refuses to start at all when the cap is not configured', () => {
    const env = {
      ISSUER: 'https://idp.test', JWKS_URL: 'https://idp.test/jwks', PROVISIONER_AUDIENCE: 'agent-provisioner',
      PUBLIC_BASE_URL: 'https://provisioner.test', SHARED_AGENT_OP_URL: 'https://op.test',
      STANDARD_JOB_NAME: 'job', PROJECT_ID: 'xaa-test', REGION: 'asia-northeast1',
      AGENT_MAX_LIFETIME_SECONDS: '86400', ACTIVITY_TOPIC: 'agent-activity-stream',
    };
    expect(() => loadConfig(env)).toThrow(/MAX_FULL_ISOLATION_AGENTS/);
    expect(() => loadConfig({ ...env, MAX_FULL_ISOLATION_AGENTS: '2' })).not.toThrow();
  });
});
