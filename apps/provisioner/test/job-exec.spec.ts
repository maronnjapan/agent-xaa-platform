import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { RETIRED_RUNTIME_ENV_KEYS, RUNTIME_ENV_KEYS, RUNTIME_STATIC_ENV_KEYS } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { ExecutionAlreadyRunning, startAgentExecution } from '../src/job/execute.js';
import { createAgentRegistration } from '../src/agent/registration.js';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type TokenIssuer } from './helpers.js';

/**
 * RULE-04. An agent is a Job Execution, not a service: it starts, does its work, and
 * ends when the job's task timeout says so.
 *
 * Everything specific to one agent arrives as an environment override, and nothing
 * else does. The shared STANDARD job definition therefore contains no agent's data,
 * which is what makes one definition safe for every agent — an `AGENT_ID` on the
 * definition would be an identity every execution inherited.
 *
 * One execution per agent. Two would authenticate as the same identity and race each
 * other for the same state, which is a conflict rather than a retry.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

const OVERRIDES = {
  AGENT_ID: 'agent-abcdefghijklmnopqrstuvwxyz',
  HUMAN_SUBJECT: 'testuser',
  TASK_ID: 'task-1',
  AGENT_CREATED_AT: '2026-03-01T00:00:00Z',
  AGENT_EXPIRES_AT: '2026-03-01T08:00:00Z',
  AGENT_OP_BASE_URL: 'https://shared-agent-op.test',
  TOOL_MANIFEST: '{"agent_id":"agent-abcdefghijklmnopqrstuvwxyz","expires_at":"2026-03-01T08:00:00Z","tools":[]}',
  AGENT_CLIENT_PRIVATE_JWK: '{"kty":"EC"}',
  ISOLATION_LEVEL: 'standard' as const,
};

async function registered() {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');
  await createAgentRegistration(documents, {
    agent_id: OVERRIDES.AGENT_ID, human_subject: 'testuser',
    client_auth: { method: 'client_assertion_jwt', jwk_thumbprint: 'tp', public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } },
    idp_connection_id: `idpconn-${OVERRIDES.AGENT_ID}`,
    allowed_audiences: [], resources: [], scopes: [], trusted_resource_as: [],
    created_at: OVERRIDES.AGENT_CREATED_AT, expires_at: OVERRIDES.AGENT_EXPIRES_AT,
    status: 'PROVISIONING', dedicated_op: null, isolation_level: 'standard', job_execution_name: null,
  });
  const runs: Array<{ jobName: string; env: Array<{ name: string; value: string }> }> = [];
  const runner = {
    async runJob(input: { jobName: string; env: Array<{ name: string; value: string }> }) {
      runs.push(input);
      return { executionName: `${input.jobName}/executions/exec-${runs.length}` };
    },
  };
  return { documents, runner, runs };
}

describe('starting the execution that is the agent', () => {
  it('refuses a second execution for the same agent', async () => {
    const { documents, runner, runs } = await registered();
    const jobName = 'projects/p/locations/l/jobs/agent-runtime-standard';
    await startAgentExecution({ runner, documents, agentId: OVERRIDES.AGENT_ID, jobName, overrides: OVERRIDES });
    expect(runs).toHaveLength(1);

    await expect(startAgentExecution({ runner, documents, agentId: OVERRIDES.AGENT_ID, jobName, overrides: OVERRIDES }))
      .rejects.toThrow(ExecutionAlreadyRunning);
    expect(runs).toHaveLength(1);
    const meta = await documents.get<{ job_execution_name: string }>('agents', `${OVERRIDES.AGENT_ID}__meta`);
    expect(meta!.job_execution_name).toBe(`${jobName}/executions/exec-1`);
  });

  it('overrides exactly the per-agent keys and none of the static ones', async () => {
    const { documents, runner, runs } = await registered();
    await startAgentExecution({
      runner, documents, agentId: OVERRIDES.AGENT_ID,
      jobName: 'projects/p/locations/l/jobs/agent-runtime-standard', overrides: OVERRIDES,
    });
    const names = runs[0]!.env.map((entry) => entry.name);
    expect([...names].sort()).toEqual([...RUNTIME_ENV_KEYS].sort());
    // The digest is added by the starter rather than by the caller, so the manifest the
    // Runtime checks is the one that was actually put on the execution.
    expect(names).toContain('TOOL_MANIFEST_SHA256');
    const digest = runs[0]!.env.find((entry) => entry.name === 'TOOL_MANIFEST_SHA256')!.value;
    // Lower-case hex over the raw string, which is what the Runtime's own check
    // computes. The two used to disagree on encoding, and an execution that could not
    // verify its manifest refuses to start — a failure with no visible cause.
    expect(digest).toBe(createHash('sha256').update(OVERRIDES.TOOL_MANIFEST, 'utf8').digest('hex'));
    for (const key of [...RUNTIME_STATIC_ENV_KEYS, ...RETIRED_RUNTIME_ENV_KEYS]) expect(names).not.toContain(key);
  });

  it('refuses an override set that is not exactly the contract', async () => {
    const { documents, runner } = await registered();
    const { TASK_ID, ...missing } = OVERRIDES;
    expect(TASK_ID).toBe('task-1');
    await expect(startAgentExecution({
      runner, documents, agentId: OVERRIDES.AGENT_ID,
      jobName: 'projects/p/locations/l/jobs/agent-runtime-standard',
      overrides: missing as typeof OVERRIDES,
    })).rejects.toThrow(/runtime env overrides must be exactly/);
  });

  it('sends a STANDARD agent to the shared job and a FULL_ISOLATION one to its own', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    for (const [capability, isolationLevel] of [['document.read', 'standard'], ['finance.payment.approve', 'full_isolation']] as const) {
      const decisionId = await seedDecision(target, { capabilities: [capability], isolationLevel });
      const response = await issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
      expect(response.status).toBe(201);
    }
    expect(target.jobRuns[0]!.jobName).toMatch(/\/jobs\/agent-runtime-standard$/);
    // The dedicated job's name comes from what the creation returned, not from string
    // concatenation here (T-PROV-24).
    expect(target.jobRuns[1]!.jobName).toMatch(/\/jobs\/agent-runtime-[0-9a-z]{12}$/);
  });

  it('gives three agents three executions with three different ids', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    for (const task of ['a', 'b', 'c']) {
      const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
      const response = await issuer.provision(target, { decision_id: decisionId, task_id: task, requested_lifetime_hours: 8 });
      expect(response.status).toBe(201);
    }
    expect(target.jobRuns).toHaveLength(3);
    const agentIds = target.jobRuns.map((run) => run.env.find((entry) => entry.name === 'AGENT_ID')!.value);
    expect(new Set(agentIds).size).toBe(3);
    // Every one of them runs on the same shared job: a STANDARD agent gets no
    // infrastructure of its own (RULE-31).
    expect(new Set(target.jobRuns.map((run) => run.jobName)).size).toBe(1);
    expect(target.admin.calls).toEqual([]);
  });
});
