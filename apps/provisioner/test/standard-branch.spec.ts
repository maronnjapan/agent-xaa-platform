import { beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type ProvisionerHarness, type TokenIssuer } from './helpers.js';

/**
 * RULE-31, as a shape rather than as a promise: Agent Creation is not Infrastructure
 * Creation.
 *
 * A STANDARD agent gets a registration, a key, an IdP connection and an execution on
 * the shared job. It gets no Cloud Run Service, no Service Account, no KMS key and no
 * IAM binding — which is what lets the platform make and discard agents all day without
 * touching anything Terraform owns, and what keeps `terraform plan` empty afterwards.
 *
 * The GCP admin surface is injected as an interface precisely so this can be asserted
 * by counting: zero calls, rather than "no call we thought to look for".
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

async function provision(target: ProvisionerHarness, capabilities: string[], task = 't'): Promise<Response> {
  const decisionId = await seedDecision(target, { capabilities });
  return issuer.provision(target, { decision_id: decisionId, task_id: task, requested_lifetime_minutes: 480 });
}

describe('the STANDARD branch', () => {
  it('calls the GCP admin API zero times', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const response = await provision(target, ['document.read', 'document.write']);
    expect(response.status).toBe(201);
    expect(target.admin.calls).toEqual([]);
    expect(target.jobRuns).toHaveLength(1);
  });

  it('still calls it zero times for ten agents in a row', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    for (let index = 0; index < 10; index += 1) {
      expect((await provision(target, ['document.read'], `task-${index}`)).status).toBe(201);
    }
    // Ten agents, ten executions, and not one service account: the number an operator
    // would count with `gcloud iam service-accounts list` before and after.
    expect(target.jobRuns).toHaveLength(10);
    expect(target.admin.calls).toEqual([]);
    expect(await target.documents.listAll('dedicated_resources')).toEqual([]);
  });

  /**
   * REQ-04-027. `risk_level` is an audit and display attribute. The finance connector
   * is rated `high`, and provisioning against it at STANDARD stays STANDARD: raising
   * isolation here would be this service quietly overruling a decision the
   * Authorization Platform already recorded and the person already saw (RULE-07).
   */
  it('leaves a high-risk tool at the isolation level the decision named', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const response = await provision(target, ['finance.payment.read', 'finance.payment.approve']);
    expect(response.status).toBe(201);

    const body = await response.json() as { agent_id: string; isolation_level: string; allowed_tools: string[] };
    expect(body.isolation_level).toBe('standard');
    expect(body.allowed_tools).toContain('internal.finance.payment.approve');
    const registration = await target.documents.get<{ isolation_level: string; dedicated_op: string | null }>(
      'agents', `${body.agent_id}__meta`,
    );
    expect(registration!.isolation_level).toBe('standard');
    expect(registration!.dedicated_op).toBe(null);
    expect(target.admin.calls).toEqual([]);
  });

  it('runs every STANDARD agent on the one shared job, named the way Cloud Run names one', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    await provision(target, ['document.read'], 'a');
    await provision(target, ['document.read'], 'b');
    expect(new Set(target.jobRuns.map((run) => run.jobName)))
      .toEqual(new Set([target.deps.config.standardJobName]));
    // `Jobs.runJob` takes the job's full resource name and refuses a bare id. The
    // FULL_ISOLATION branch gets one from the API for free; this branch gets whatever
    // the deployment set, and the call is only reached after a consent has been given.
    for (const run of target.jobRuns) {
      expect(run.jobName).toMatch(/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/);
    }
  });

  /**
   * The dedicated module is reachable from one place, and that place is inside the
   * `full_isolation` branch. A second caller is how a STANDARD request would end up
   * creating infrastructure without any test noticing.
   */
  it('reaches the dedicated module from the full_isolation branch and nowhere else', async () => {
    const root = new URL('../src', import.meta.url).pathname;
    const callers: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (full.includes('/testing/')) continue;
        if ((await readFile(full, 'utf8')).includes('deps.createDedicated(')) callers.push(full.split('/src/')[1]!);
      }
    };
    await walk(root);
    expect(callers).toEqual(['provisioning/flow.ts']);

    const flow = await readFile(join(root, 'provisioning/flow.ts'), 'utf8');
    const lines = flow.split('\n');
    const guard = lines.findIndex((line) => line.includes("request.isolationLevel === 'full_isolation' ?"));
    expect(guard).toBeGreaterThan(-1);
    expect(lines.findIndex((line) => line.includes('deps.createDedicated('))).toBeGreaterThan(guard);
  });
});
