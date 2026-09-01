import { describe, expect, it } from 'vitest';
import { createLogger } from '@xaa/logging';
import { createCatalogRepository } from '../src/catalog/repository.js';
import { provisionAgent } from '../src/provisioning/flow.js';
import {
  PROVISIONING_STEPS, PreconditionFailed, ProvisioningHalted, runProvisioning,
  type ProvisioningStep, type Step, type StepContext,
} from '../src/orchestrator.js';
import { createProvisionerHarness, seedDecision, type ProvisionerHarness } from './helpers.js';

const context: StepContext = { agentId: 'agent-abcdefghijklmnopqrstuvwxyz', isolationLevel: 'standard', transactionId: 'txn-1' };

function step(id: ProvisioningStep, options: Partial<Step> & { fail?: boolean } = {}): Step {
  return {
    id,
    run: options.run ?? (async () => { if (options.fail) throw new Error(`${id} failed`); }),
    compensate: options.compensate ?? 'noop',
  };
}

/** The order the provisioning route actually ran, taken from the line it writes. */
function stepsFrom(harness: ProvisionerHarness): string[] {
  const line = harness.logs.map((entry) => JSON.parse(entry) as { event: string; fields: { completed?: string[] } })
    .find((entry) => entry.event === 'provisioner.steps');
  return line?.fields.completed ?? [];
}

async function provision(target: ProvisionerHarness, capabilities: string[], isolationLevel: 'standard' | 'full_isolation') {
  const decisionId = await seedDecision(target, { capabilities, isolationLevel });
  const decision = await target.documents.get<{ effective_capabilities: string[] }>('authorization_decisions', decisionId);
  return provisionAgent({
    ...target.deps,
    logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
    catalogue: createCatalogRepository(target.documents),
  }, {
    humanSubject: 'testuser',
    taskId: 'task-1',
    effectiveCapabilities: decision!.effective_capabilities,
    isolationLevel,
    constraints: {},
    lifetime: { kind: 'requested', hours: 8 },
  });
}

describe('the eleven steps', () => {
  it('runs a STANDARD provisioning in the order docs 07 §3.3 fixes', async () => {
    const target = await createProvisionerHarness();
    const outcome = await provision(target, ['document.read'], 'standard');
    expect(outcome.status).toBe(201);
    expect(stepsFrom(target)).toEqual([
      'create_transaction', 'resolve_tools', 'generate_agent_identity', 'set_expires_at',
      'idp_consent', 'verify_idp_connection', 'register_agent', 'start_job_execution', 'activate',
    ]);
  });

  it('adds the dedicated resources after the connection is verified, never before', async () => {
    const target = await createProvisionerHarness();
    const outcome = await provision(target, ['finance.payment.approve'], 'full_isolation');
    expect(outcome.status).toBe(201);
    const ran = stepsFrom(target);
    expect(ran).toContain('create_dedicated_resources');
    expect(ran.indexOf('create_dedicated_resources')).toBeGreaterThan(ran.indexOf('verify_idp_connection'));
    expect(ran.indexOf('create_dedicated_resources')).toBeLessThan(ran.indexOf('register_agent'));
  });

  it('keeps every step it ran inside the declared list, in position', async () => {
    const target = await createProvisionerHarness();
    await provision(target, ['document.read'], 'standard');
    const positions = stepsFrom(target).map((id) => PROVISIONING_STEPS.indexOf(id as ProvisioningStep));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it('refuses a run whose steps were handed over out of order', async () => {
    await expect(runProvisioning(
      [step('register_agent'), step('idp_consent')], { ...context },
    )).rejects.toBeInstanceOf(PreconditionFailed);
  });
});

describe('rolling back', () => {
  it('undoes the completed steps in reverse', async () => {
    const undone: string[] = [];
    const result = await runProvisioning([
      step('idp_consent', { compensate: async () => { undone.push('idp_consent'); } }),
      step('register_agent', { compensate: async () => { undone.push('register_agent'); } }),
      step('start_job_execution', { fail: true }),
    ], { ...context });
    expect(result.failedAt).toBe('start_job_execution');
    expect(undone).toEqual(['register_agent', 'idp_consent']);
  });

  it('carries on when one compensation fails, and reports every failure', async () => {
    const undone: string[] = [];
    const lines: string[] = [];
    const logger = createLogger('provisioner', 'provisioner', (line) => { lines.push(line); });
    const result = await runProvisioning([
      step('idp_consent', { compensate: async () => { undone.push('idp_consent'); } }),
      step('register_agent', { compensate: async () => { throw new Error('registration delete refused'); } }),
      step('start_job_execution', { fail: true }),
    ], { ...context }, logger);
    expect(undone).toEqual(['idp_consent']);
    expect(result.compensationFailures).toEqual([{ step: 'register_agent', error: 'registration delete refused' }]);
    expect(lines.join('\n')).toContain('registration delete refused');
  });

  it('undoes nothing when a step asks to pause rather than fail', async () => {
    const undone: string[] = [];
    const result = await runProvisioning([
      step('create_transaction', { compensate: async () => { undone.push('create_transaction'); } }),
      step('idp_consent', { run: async () => { throw new ProvisioningHalted('idp_consent'); } }),
      step('register_agent', { run: async () => { undone.push('register_agent ran'); } }),
    ], { ...context });
    expect(result.haltedAt).toBe('idp_consent');
    expect(undone).toEqual([]);
  });
});

/**
 * The failure the route used to answer with a bare 500, leaving a registration behind
 * and the transaction stuck at PROVISIONING (T-PROV-14).
 */
describe('a provisioning that fails after the first write', () => {
  async function failingJobRun(isolationLevel: 'standard' | 'full_isolation') {
    const target = await createProvisionerHarness();
    const decisionId = await seedDecision(target, {
      capabilities: isolationLevel === 'standard' ? ['document.read'] : ['finance.payment.approve'],
      isolationLevel,
    });
    const outcome = await provisionAgent({
      ...target.deps,
      jobs: { async runJob() { throw new Error('cloud run refused'); } },
      logger: createLogger('provisioner', 'provisioner', (line) => { target.logs.push(line); }),
      catalogue: createCatalogRepository(target.documents),
    }, {
      humanSubject: 'testuser',
      taskId: 'task-1',
      effectiveCapabilities: (await target.documents.get<{ effective_capabilities: string[] }>(
        'authorization_decisions', decisionId,
      ))!.effective_capabilities,
      isolationLevel,
      constraints: {},
      lifetime: { kind: 'requested', hours: 8 },
    });
    return { target, outcome };
  }

  it('deletes the registration, revokes the connection and fails the transaction', async () => {
    const { target, outcome } = await failingJobRun('standard');
    expect(outcome.status).toBe(500);

    const registrations = (await target.documents.listAll('agents')).filter((row) => row.id.endsWith('__meta'));
    expect(registrations).toEqual([]);
    const manifests = (await target.documents.listAll('agents')).filter((row) => row.id.endsWith('__manifest'));
    expect(manifests).toEqual([]);
    expect(target.revokedConnections).toHaveLength(1);

    const transactions = await target.documents.listAll<{ status: string; pending_step: string }>('provisioning_transactions');
    expect(transactions[0]!.data.status).toBe('FAILED');
    expect(transactions[0]!.data.pending_step).toBe('start_job_execution');
  });

  it('publishes no AGENT_PROVISIONED event', async () => {
    const { target } = await failingJobRun('standard');
    const kinds = target.activity.map((event) => (event.detail as { activity_kind?: string }).activity_kind);
    expect(kinds).not.toContain('AGENT_PROVISIONED');
  });

  it('hands the dedicated resources to Lifecycle instead of leaving them CREATING', async () => {
    const { target } = await failingJobRun('full_isolation');
    const ledger = (await target.documents.listAll<{ status: string; last_error: string | null }>('dedicated_resources'))
      .find((row) => row.id.startsWith('agent-'));
    expect(ledger!.data.status).toBe('FAILED');
    expect(ledger!.data.last_error).not.toBe(null);
  });
});

describe('the IdP connection gate', () => {
  it('answers 409 precondition_failed rather than registering an unusable agent', async () => {
    const target = await createProvisionerHarness({ verifyStatus: 'PENDING' });
    const outcome = await provision(target, ['document.read'], 'standard');
    expect(outcome.status).toBe(409);
    expect(outcome.body).toEqual({
      error: 'precondition_failed', expected_step: 'verify_idp_connection', actual_step: 'register_agent',
    });
    expect((await target.documents.listAll('agents')).filter((row) => row.id.endsWith('__meta'))).toEqual([]);
    expect(target.jobRuns).toHaveLength(0);
  });
});
