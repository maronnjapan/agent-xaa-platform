import { describe, expect, it } from 'vitest';
import { compile, paymentSeedSchema, paymentSchema, SchemaValidationError } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createPaymentRepository, InvalidState } from '../src/store/payments.js';

const assertSeed = compile(paymentSeedSchema);
const SUBJECTS = { approvedBy: 'user-1', approvedByAgent: 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz' };

function repository() {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'resource-finance-api');
  return { documents, store: createPaymentRepository(documents) };
}

async function seed(documents: ReturnType<typeof repository>['documents'], overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `pay_${crypto.randomUUID()}`;
  await documents.set('payments', id, {
    payment_id: id, requester_subject: 'user-1', amount: 1000, currency: 'JPY', counterparty: 'ACME',
    status: 'pending_approval', memo: 'm', approved_by: null, approved_by_agent: null, approved_at: null,
    created_at: new Date().toISOString(), ...overrides,
  });
  return id;
}

describe('payment schema', () => {
  it('rejects a fractional or non-positive amount', () => {
    const base = { requester_subject: 'user-1', currency: 'JPY', counterparty: 'ACME', memo: 'm' };
    expect(() => assertSeed({ ...base, amount: 10.5 })).toThrow(SchemaValidationError);
    expect(() => assertSeed({ ...base, amount: 0 })).toThrow(SchemaValidationError);
    expect(() => assertSeed({ ...base, amount: '1000' })).toThrow(SchemaValidationError);
    expect(() => assertSeed({ ...base, amount: 1000 })).not.toThrow();
  });

  it('accepts only JPY', () => {
    expect(() => assertSeed({ requester_subject: 'u', amount: 1, currency: 'USD', counterparty: 'c', memo: 'm' }))
      .toThrow(SchemaValidationError);
  });

  it('keeps the three approval fields out of the input schema', () => {
    for (const field of ['approved_by', 'approved_by_agent', 'approved_at']) {
      expect(Object.keys(paymentSeedSchema.properties)).not.toContain(field);
    }
    expect(paymentSchema.required).toContain('approved_by');
  });
});

describe('payment repository', () => {
  it('records both subjects on approval', async () => {
    const { documents, store } = repository();
    const id = await seed(documents);
    const result = await store.approve(id, 'user-1', SUBJECTS);
    expect(result.outcome).toBe('approved');
    const stored = await documents.get<{ approved_by: string; approved_by_agent: string; status: string }>('payments', id);
    expect(stored!.approved_by).toBe('user-1');
    expect(stored!.approved_by_agent).toBe(SUBJECTS.approvedByAgent);
    expect(stored!.status).toBe('approved');
  });

  it('is idempotent and keeps the first approver', async () => {
    const { documents, store } = repository();
    const id = await seed(documents);
    const first = await store.approve(id, 'user-1', SUBJECTS);
    const second = await store.approve(id, 'user-1', { approvedBy: 'someone', approvedByAgent: 'urn:xaa:agent:agent-zzzzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(second.outcome).toBe('already_approved');
    expect(second.outcome === 'already_approved' && second.payment.approved_by).toBe('user-1');
    expect(first.outcome === 'approved' && first.payment.approved_at).toBe(second.outcome === 'already_approved' ? second.payment.approved_at : '');
  });

  it('refuses to approve from rejected or executed', async () => {
    const { documents, store } = repository();
    for (const status of ['rejected', 'executed']) {
      const id = await seed(documents, { status });
      await expect(store.approve(id, 'user-1', SUBJECTS)).rejects.toBeInstanceOf(InvalidState);
    }
  });

  it('hides another requester\'s payment', async () => {
    const { documents, store } = repository();
    const id = await seed(documents);
    expect(await store.get(id, 'user-2')).toBeUndefined();
    expect((await store.approve(id, 'user-2', SUBJECTS)).outcome).toBe('not_found');
  });

  it('filters the list by status and honours the limit', async () => {
    const { documents, store } = repository();
    await seed(documents);
    await seed(documents, { status: 'approved' });
    expect(await store.list('user-1', { limit: 20 })).toHaveLength(2);
    expect(await store.list('user-1', { status: 'approved', limit: 20 })).toHaveLength(1);
    expect(await store.list('user-1', { limit: 1 })).toHaveLength(1);
  });
});
