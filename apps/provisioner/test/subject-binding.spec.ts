import { beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type ProvisionerHarness, type TokenIssuer } from './helpers.js';

/**
 * RULE-43. Who an agent is made for is the Access Token's `sub`, and nothing else.
 *
 * The body may name a `human_subject`, because the screen that built it knows who is
 * logged in — but it is compared and then dropped. Reading it afterwards is how a
 * request that says "make this for someone else" gets obeyed, so the binding removes
 * the field rather than trusting each handler to ignore it.
 *
 * The check lives in `@xaa/control-plane-auth`'s `humanSubjectMiddleware`, the eighth
 * step of the shared Control Plane chain, which every Control Plane service runs.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

async function harness(): Promise<ProvisionerHarness> {
  return createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
}

describe('binding the provisioning to the caller', () => {
  it('refuses a body that names someone other than the token holder', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await issuer.provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8, human_subject: 'user-b',
    }, { token: await issuer.accessToken({ sub: 'user-a' }) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'human_subject_mismatch' });
  });

  it('writes no transaction when it refuses', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    await issuer.provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8, human_subject: 'user-b',
    }, { token: await issuer.accessToken({ sub: 'user-a' }) });

    expect(await target.documents.listAll('provisioning_transactions')).toHaveLength(0);
    expect(await target.documents.listAll('agents')).toHaveLength(0);
    expect(target.jobRuns).toHaveLength(0);
  });

  it('records the token subject on the agent when the two agree', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'], humanSubject: 'user-a' });
    const response = await issuer.provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8, human_subject: 'user-a',
    }, { token: await issuer.accessToken({ sub: 'user-a' }) });

    expect(response.status).toBe(201);
    const { agent_id: agentId } = await response.json() as { agent_id: string };
    const registration = await target.documents.get<{ human_subject: string }>('agents', `${agentId}__meta`);
    expect(registration!.human_subject).toBe('user-a');
  });

  it('hands the handlers a body with the field already removed', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'], humanSubject: 'user-a' });
    const response = await issuer.provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8, human_subject: 'user-a',
    }, { token: await issuer.accessToken({ sub: 'user-a' }) });
    // A body carrying `human_subject` reaches the schema without it. If the field
    // survived, the closed schema would refuse the whole request as an unknown key —
    // so a 201 here is the assertion that it was stripped.
    expect(response.status).toBe(201);
  });

  /**
   * The route handlers must reach for `c.get('humanSubject')`, never for the body. The
   * two agree today only because the middleware compared them; a handler that read the
   * body would keep working right up until someone removed that comparison.
   */
  it('reads no human_subject out of a request body anywhere in the routes', async () => {
    const root = new URL('../src/routes', import.meta.url).pathname;
    const offenders: string[] = [];
    for (const entry of await readdir(root)) {
      const text = await readFile(join(root, entry), 'utf8');
      // `body.human_subject` in the internal re-provisioning route is not this: that
      // caller is `sa-lifecycle` and holds no person's token, so there is no `sub` to
      // take the subject from. Its own route checks the caller instead.
      if (entry === 'reprovision.ts') continue;
      if (/\bbody\s*(\.|\[['"])\s*human_subject/.test(text)) offenders.push(entry);
      if (/validatedBody\s*(\.|\[['"])\s*human_subject/.test(text)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
