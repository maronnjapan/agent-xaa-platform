import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import type { ControlPlaneVariables } from '@xaa/control-plane-auth';
import { createDecisionRoute } from '../src/routes/decisions.js';
import { createAuthorizationStore } from '../src/store/authorization-store.js';
import { AUTHZ_COLLECTIONS } from '../src/store/collections.js';
import type { DecisionRecord } from '../src/pipeline/decide.js';
import { createFakeVertex, seedAuthorizationData, testConfig } from './helpers.js';

const REQUEST = { purpose: '書類整理', description: '書類を読んで整理する', requested_lifetime_minutes: 480 };

/**
 * The route with the guard already satisfied: what is under test here is what the
 * handler does when something downstream goes wrong, and the eight-step chain in
 * front of it is fixed by `step-order.spec.ts`.
 */
async function route(options: {
  failWritesTo?: string;
  corrupt?: (record: DecisionRecord) => void;
} = {}) {
  const firestore = createFirestoreDouble();
  const real = createFirestoreDocumentStore(firestore, 'authorization');
  await seedAuthorizationData(real, ['document.read'], createFirestoreDocumentStore(firestore, 'seed'));
  const documents: DocumentStore = {
    ...real,
    set: async (collection, id, data) => {
      if (collection === options.failWritesTo) throw new Error('firestore unavailable');
      await real.set(collection, id, data);
    },
  };

  const app = new Hono<{ Variables: ControlPlaneVariables }>();
  app.use('/decisions', async (context, next) => {
    context.set('humanSubject', 'testuser');
    context.set('validatedBody', { ...REQUEST });
    await next();
  });
  app.route('/decisions', createDecisionRoute({
    store: createAuthorizationStore(documents),
    vertex: createFakeVertex({ capabilities: ['document.read'] }),
    clock: { now: () => Date.parse('2026-03-01T00:00:00Z') },
    modelVersion: testConfig.vertexModel,
    taxonomyVersion: testConfig.taxonomyVersion,
    maxLifetimeMinutes: 24 * 60,
    ...(options.corrupt ? { onDecided: options.corrupt } : {}),
  }));

  const response = await app.request('http://authorization.test/decisions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(REQUEST),
  });
  return { response, documents: real };
}

describe('a decision that cannot be completed is not half-answered', () => {
  it('answers 200 with the effective capabilities when everything holds', async () => {
    const { response } = await route();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'decided', effective_capabilities: ['document.read'] });
  });

  /**
   * RULE-10: the decision record is the only thing that says what an agent may do.
   * If it was not written, answering with capabilities would hand out an authority
   * nothing on the platform has a record of.
   */
  it('answers 500 and names no capability when the decision cannot be stored', async () => {
    const { response, documents } = await route({ failWritesTo: AUTHZ_COLLECTIONS.authorizationDecisions });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'internal_error' });
    expect(body).not.toContain('effective_capabilities');
    expect(await documents.listAll(AUTHZ_COLLECTIONS.authorizationDecisions)).toEqual([]);
  });

  /**
   * The response contract is checked before the response is sent, not after. A body
   * that does not match is an internal error here rather than something the caller is
   * left to interpret.
   */
  it('answers 500 when the response does not match the contract', async () => {
    const { response } = await route({ corrupt: (record) => { record.security_profile.risk_score = 101; } });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'internal_error' });
    expect(body).not.toContain('effective_capabilities');
  });
});
