import { beforeAll, describe, expect, it } from 'vitest';
import { agentDefinitionSchema, validateAgentDefinition, DefinitionRejected } from '../src/routes/agent-definition.js';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type ProvisionerHarness, type TokenIssuer } from './helpers.js';

/**
 * What `POST /provisioning` accepts (T-PROV-10).
 *
 * The body names a decision, a task and a lifetime — and nothing about authority.
 * The capabilities and the isolation level were settled by the Authorization Platform
 * and are read back from `authorization_decisions`, so a request that states them is
 * refused rather than merged (RULE-07): a body that could name an isolation level is a
 * body that could lower one.
 *
 * The schema is closed at every level, so an unknown field is a refusal rather than a
 * value quietly dropped.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

async function harness(): Promise<ProvisionerHarness> {
  return createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
}

async function send(target: ProvisionerHarness, body: Record<string, unknown>): Promise<Response> {
  const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
  return issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480, ...body });
}

describe('the agent definition a provisioning request carries', () => {
  it('accepts the three fields it is made of', async () => {
    const target = await harness();
    expect((await send(target, {})).status).toBe(201);
    expect(Object.keys(agentDefinitionSchema.properties).sort())
      .toEqual(['decision_id', 'human_subject', 'requested_lifetime_minutes', 'task_id']);
    expect(agentDefinitionSchema.additionalProperties).toBe(false);
  });

  it('refuses a lifetime beyond the platform ceiling', async () => {
    const target = await harness();
    const response = await send(target, { requested_lifetime_minutes: 1500 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(target.jobRuns).toHaveLength(0);
  });

  it('refuses a body that states an isolation level, whichever value it names', async () => {
    for (const isolationLevel of ['DEDICATED_IDENTITY', 'standard', 'full_isolation']) {
      const target = await harness();
      const response = await send(target, { isolation_level: isolationLevel });
      // RULE-30: `DEDICATED_IDENTITY` has no implementation, and the two levels that do
      // are not the caller's to choose either. All three are refused by the same rule,
      // which is why there is no branch here that only knows the discarded name.
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'authorization_field_not_allowed' });
      expect(await target.documents.listAll('provisioning_transactions')).toHaveLength(0);
    }
  });

  it('refuses an unknown field', async () => {
    const target = await harness();
    const response = await send(target, { foo: 'bar' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unexpected_field' });
    expect(target.jobRuns).toHaveLength(0);
  });

  it('refuses a missing decision id and a malformed one', () => {
    expect(() => validateAgentDefinition({ task_id: 't', requested_lifetime_minutes: 480 }, 24))
      .toThrow(DefinitionRejected);
    expect(() => validateAgentDefinition({ decision_id: 'nope', task_id: 't', requested_lifetime_minutes: 480 }, 24))
      .toThrow(DefinitionRejected);
    expect(() => validateAgentDefinition('not an object', 24)).toThrow(DefinitionRejected);
  });

  /**
   * RULE-30 again, this time as an absence: the third isolation level must not exist
   * as a constant, a type or a branch anywhere in this app, because a value the code
   * can name is a value some path can eventually set.
   */
  it('knows no third isolation level', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = new URL('../src', import.meta.url).pathname;
    const found: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if ((await readFile(full, 'utf8')).includes('DEDICATED_IDENTITY')) found.push(full);
      }
    };
    await walk(root);
    expect(found).toEqual([]);
  });
});
