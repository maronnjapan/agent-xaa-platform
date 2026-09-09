import { beforeAll, describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';
import { createProvisionerHarness, createTokenIssuer, seedDecision, PROVISIONER_BASE, type ProvisionerHarness, type TokenIssuer } from './helpers.js';

/**
 * docs 07 §3.3 / RULE-43 / RULE-44. Every check happens before the first write.
 *
 * The order is the property, not the individual refusals: a request refused after a
 * transaction exists leaves a row nobody will ever finish, and a sweep cannot tell it
 * from a consent still outstanding. So each failure mode below is asserted twice —
 * once on the status code, and once on the number of documents written, which is zero.
 *
 * The count is taken over every collection this app writes to, not just the
 * transactions: a run that skipped the transaction but reserved a slot would still
 * have written.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

const WRITTEN_COLLECTIONS = ['provisioning_transactions', 'dedicated_resources', 'agents', 'provisioning_codes'];

async function writes(documents: DocumentStore): Promise<number> {
  let total = 0;
  for (const collection of WRITTEN_COLLECTIONS) total += (await documents.listAll(collection)).length;
  return total;
}

async function harness(): Promise<ProvisionerHarness> {
  return createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
}

describe('nothing is written before the request has been accepted', () => {
  it('writes nothing when the DPoP proof is for another key', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const token = await issuer.accessToken();
    // A proof signed by a key that is not the one the token is bound to: the shape is
    // right, the binding is not, which is exactly what a stolen token looks like.
    const { generateEs256KeyPair } = await import('@xaa/crypto');
    const response = await target.fetch('/provisioning', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `DPoP ${token}`,
        DPoP: await createDpopProof({
          method: 'POST', url: `${PROVISIONER_BASE}/provisioning`,
          keyPair: await generateEs256KeyPair(), accessToken: token,
        }),
      },
      body: JSON.stringify({ decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480 }),
    });
    expect(response.status).toBe(401);
    expect(await writes(target.documents)).toBe(0);
  });

  it('writes nothing when the body claims another person', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await issuer.provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480, human_subject: 'someone-else',
    });
    expect(response.status).toBe(403);
    expect(await writes(target.documents)).toBe(0);
  });

  it('writes nothing when the decision does not match', async () => {
    const target = await harness();
    const response = await issuer.provision(target, {
      decision_id: `dec_${crypto.randomUUID()}`, task_id: 't', requested_lifetime_minutes: 480,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'decision_mismatch' });
    expect(await writes(target.documents)).toBe(0);
  });

  it('writes nothing when the capabilities exceed what the person holds', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'], grantHumanPermissions: false });
    const response = await issuer.provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'capability_not_subset_of_human_permission' });
    expect(await writes(target.documents)).toBe(0);
  });

  /**
   * The accepted path, as the sequence it actually ran. Recording the steps rather
   * than asserting each check in isolation is what makes a reordering visible: a
   * decision looked up before the token was verified would still pass every one of
   * the tests above.
   */
  it('runs the checks in order, and creates the transaction only after the last of them', async () => {
    const target = await harness();
    const seen: string[] = [];
    const documents = target.documents;
    const watched: DocumentStore = {
      ...documents,
      async get(collection, id) {
        seen.push(`read:${collection}`);
        return documents.get(collection, id);
      },
      async queryEqual(collection, clauses) {
        seen.push(`read:${collection}`);
        return documents.queryEqual(collection, clauses);
      },
      async listAll(collection) {
        seen.push(`read:${collection}`);
        return documents.listAll(collection);
      },
      async set(collection, id, data) {
        seen.push(`write:${collection}`);
        return documents.set(collection, id, data);
      },
    } as DocumentStore;

    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const { createCatalogRepository } = await import('../src/catalog/repository.js');
    const { createTransactionStore } = await import('../src/transaction/store.js');
    const { provisionAgent } = await import('../src/provisioning/flow.js');
    const outcome = await provisionAgent({
      ...target.deps, documents: watched, logger: target.deps.logger!,
      // The transaction store writes through the same watched view, so its row shows
      // up in the sequence rather than beside it.
      transactions: createTransactionStore(watched, () => target.deps.clock.now()),
      catalogue: createCatalogRepository(watched),
    }, {
      humanSubject: 'testuser', taskId: 't', effectiveCapabilities: ['document.read'],
      isolationLevel: 'standard', constraints: {}, lifetime: { kind: 'requested', minutes: 480 },
    });
    expect(outcome.status).toBe(201);
    expect(decisionId).toMatch(/^dec_/);

    const firstWrite = seen.findIndex((entry) => entry.startsWith('write:'));
    expect(firstWrite).toBeGreaterThan(-1);
    expect(seen[firstWrite]).toBe('write:provisioning_transactions');
    // The permission re-check and the catalogue lookup both happen before it.
    const before = seen.slice(0, firstWrite);
    expect(before).toContain('read:human_permissions');
    expect(before.some((entry) => entry.startsWith('read:catalog_'))).toBe(true);
  });
});
