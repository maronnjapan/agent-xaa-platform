import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createTransactionStore } from '../src/transaction/store.js';
import { InvalidTransactionTransition, isTerminal, transition, TRANSACTION_TTL_SECONDS } from '../src/transaction/state.js';
import { createCompletionCodes, COMPLETION_CODE_TTL_SECONDS } from '../src/transaction/one-time-code.js';

function store(now = () => Date.now()) {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');
  return { documents, transactions: createTransactionStore(documents, now) };
}

const seed = {
  human_subject: 'testuser', agent_id: null, required_capabilities: ['document.read'],
  required_connectors: ['internal-docs-api'], isolation_level: 'standard' as const,
  pending_step: 'resolve_tools', dedicated_short_id: null,
};

describe('provisioning transaction state', () => {
  it('refuses to resurrect a finished transaction', () => {
    expect(() => transition('COMPLETED', 'PROVISIONING')).toThrow(InvalidTransactionTransition);
    expect(() => transition('FAILED', 'PROVISIONING')).toThrow(InvalidTransactionTransition);
    expect(() => transition('ABANDONED', 'CREATED')).toThrow(InvalidTransactionTransition);
  });

  it('allows the consent detour and the direct path', () => {
    expect(transition('CREATED', 'WAITING_IDP_CONSENT')).toBe('WAITING_IDP_CONSENT');
    expect(transition('WAITING_IDP_CONSENT', 'RESUMABLE')).toBe('RESUMABLE');
    expect(transition('RESUMABLE', 'PROVISIONING')).toBe('PROVISIONING');
    expect(transition('CREATED', 'PROVISIONING')).toBe('PROVISIONING');
  });

  it('marks the three terminal states', () => {
    for (const status of ['COMPLETED', 'FAILED', 'ABANDONED'] as const) expect(isTerminal(status)).toBe(true);
    for (const status of ['CREATED', 'PROVISIONING', 'RESUMABLE'] as const) expect(isTerminal(status)).toBe(false);
  });

  it('expires thirty minutes after creation', async () => {
    const clock = Date.parse('2026-03-01T00:00:00Z');
    const { transactions } = store(() => clock);
    const created = await transactions.create(seed);
    expect(Date.parse(created.expires_at) - Date.parse(created.created_at)).toBe(TRANSACTION_TTL_SECONDS * 1000);
  });

  it('abandons once and stays abandoned', async () => {
    const { transactions } = store();
    const created = await transactions.create(seed);
    const first = await transactions.abandon(created.transaction_id);
    expect(first!.status).toBe('ABANDONED');
    const second = await transactions.abandon(created.transaction_id);
    expect(second!.status).toBe('ABANDONED');
  });

  it('rejects a document with an unknown field', async () => {
    const { transactions } = store();
    await expect(transactions.create({ ...seed, extra: 1 } as never)).rejects.toThrow();
  });

  it('mints an id with the txn_ prefix', async () => {
    const { transactions } = store();
    expect((await transactions.create(seed)).transaction_id).toMatch(/^txn_[A-Za-z0-9_-]{22}$/);
  });
});

describe('one-time completion code', () => {
  const input = { transaction_id: 'txn_aaaaaaaaaaaaaaaaaaaaaa', human_subject: 'testuser', issuer_kind: 'idp' };

  it('never stores the code in the clear', async () => {
    const { documents } = store();
    const codes = createCompletionCodes(documents);
    const code = await codes.issue(input);
    const stored = await documents.listAll('provisioning_codes');
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it('can be spent exactly once', async () => {
    const { documents } = store();
    const codes = createCompletionCodes(documents);
    const code = await codes.issue(input);
    expect((await codes.consume({ code, ...input })).ok).toBe(true);
    const second = await codes.consume({ code, ...input });
    expect(second).toMatchObject({ ok: false, status: 400, error: 'code_already_used' });
  });

  it('survives ten concurrent redemptions with one success', async () => {
    const { documents } = store();
    const codes = createCompletionCodes(documents);
    const code = await codes.issue(input);
    const results = await Promise.all(Array.from({ length: 10 }, () => codes.consume({ code, ...input })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('expires after five minutes', async () => {
    let clock = Date.parse('2026-03-01T00:00:00Z');
    const { documents } = store(() => clock);
    const codes = createCompletionCodes(documents, () => clock);
    const code = await codes.issue(input);
    clock += (COMPLETION_CODE_TTL_SECONDS + 1) * 1000;
    expect(await codes.consume({ code, ...input })).toMatchObject({ status: 400, error: 'code_expired' });
  });

  it('refuses a different transaction and a different owner', async () => {
    const { documents } = store();
    const codes = createCompletionCodes(documents);
    const code = await codes.issue(input);
    expect(await codes.consume({ code, ...input, transaction_id: 'txn_bbbbbbbbbbbbbbbbbbbbbb' }))
      .toMatchObject({ status: 400, error: 'code_transaction_mismatch' });
    expect(await codes.consume({ code, ...input, human_subject: 'someone-else' }))
      .toMatchObject({ status: 403, error: 'code_owner_mismatch' });
  });

  it('leaves the code unspent when the owner is wrong', async () => {
    const { documents } = store();
    const codes = createCompletionCodes(documents);
    const code = await codes.issue(input);
    await codes.consume({ code, ...input, human_subject: 'someone-else' });
    expect((await codes.consume({ code, ...input })).ok).toBe(true);
  });
});
