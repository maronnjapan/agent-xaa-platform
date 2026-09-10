import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { completionCodeId, PROTOCOL_VALIDATION_EVENT } from '@xaa/contracts';
import { createLogger } from '@xaa/logging';
import { createTransactionStore } from '../src/transaction/store.js';
import { reserveFullIsolationSlot } from '../src/capacity.js';
import type { DedicatedResourceRecord } from '../src/dedicated-ledger.js';
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
  task_id: 'wd-1', constraints: {}, agent_expires_at: '2026-03-01T01:00:00.000Z',
};

describe('provisioning transaction state', () => {
  it('refuses to resurrect a finished transaction', () => {
    expect(() => transition('COMPLETED', 'PROVISIONING')).toThrow(InvalidTransactionTransition);
    expect(() => transition('COMPLETED', 'PROVISIONING')).toThrow(/^invalid_transaction_transition/);
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

/**
 * 00b §1 puts `code_already_used` among the 22 protocol violations and names T-PROV-15
 * as the code that raises it. Security Detection classifies a refusal from that event;
 * a refusal that only becomes a 400 is one the pipeline never sees.
 */
describe('a code redeemed twice', () => {
  it('raises the protocol violation, carrying neither the code nor its hash', async () => {
    const lines: string[] = [];
    const logger = createLogger('provisioner', 'provisioner', (line) => { lines.push(line); });
    const { documents } = store();
    const codes = createCompletionCodes(documents, () => Date.now(), logger);
    const code = await codes.issue({ transaction_id: 'txn-1', human_subject: 'testuser', issuer_kind: 'idp' });
    const input = { code, transaction_id: 'txn-1', human_subject: 'testuser' };

    expect((await codes.consume(input)).ok).toBe(true);
    expect(await codes.consume(input)).toEqual({ ok: false, status: 400, error: 'code_already_used' });

    const events = lines.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
      .filter((entry) => entry.event === PROTOCOL_VALIDATION_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ validation: 'code_already_used', outcome: 'fail', validation_name: 'one_time_code' });
    expect(JSON.stringify(events)).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain(await completionCodeId(code));
  });

  it('stays silent on the first redemption', async () => {
    const lines: string[] = [];
    const logger = createLogger('provisioner', 'provisioner', (line) => { lines.push(line); });
    const { documents } = store();
    const codes = createCompletionCodes(documents, () => Date.now(), logger);
    const code = await codes.issue({ transaction_id: 'txn-1', human_subject: 'testuser', issuer_kind: 'idp' });
    await codes.consume({ code, transaction_id: 'txn-1', human_subject: 'testuser' });
    expect(lines.join('\n')).not.toContain(PROTOCOL_VALIDATION_EVENT);
  });
});

/**
 * docs 07 §3.2. A consent that never came back leaves a transaction holding things:
 * the public half of an agent's credential, a connection the Agent OP made, and — for
 * FULL_ISOLATION — a slot out of a hard GCP quota.
 *
 * `abandon` is what the Lifecycle sweep calls to give them back, in the reverse of the
 * order they were taken. It is idempotent because a sweep is retried: a second pass
 * over the same transaction must not revoke a connection twice or hand back a slot
 * that has since been given to someone else.
 */
describe('abandoning a transaction that timed out', () => {
  const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
  const seedFor = (agentId: string, isolationLevel: 'standard' | 'full_isolation' = 'standard') => ({
    ...seed, agent_id: agentId, isolation_level: isolationLevel,
  });

  function abandoning(now: () => number = () => Date.now()) {
    const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'provisioner');
    const revoked: string[] = [];
    const transactions = createTransactionStore(documents, now, {
      revokeIdpConnection: async (idpConnectionId) => { revoked.push(idpConnectionId); },
    });
    return { documents, transactions, revoked };
  }

  it('marks it ABANDONED, revokes the connection once and frees the slot', async () => {
    let clock = Date.parse('2026-03-01T00:00:00Z');
    const { documents, transactions, revoked } = abandoning(() => clock);
    const created = await transactions.create(seedFor(AGENT_ID, 'full_isolation'));
    await documents.set('dedicated_resources', AGENT_ID, {
      agent_id: AGENT_ID, status: 'CREATING', created: [],
      created_at: created.created_at, expires_at: created.expires_at, last_error: null,
    } satisfies DedicatedResourceRecord);
    await documents.set('dedicated_resources', '_slots', { holders: [AGENT_ID] });

    // Past the half hour: the consent is not coming.
    clock += (TRANSACTION_TTL_SECONDS + 60) * 1000;
    const abandoned = await transactions.abandon(created.transaction_id);

    expect(abandoned!.status).toBe('ABANDONED');
    expect(revoked).toEqual([`idpconn-${AGENT_ID}`]);
    // Nothing was built under the slot, so it goes straight back rather than waiting
    // for a cleanup that would have nothing to delete.
    expect((await documents.get<DedicatedResourceRecord>('dedicated_resources', AGENT_ID))!.status).toBe('RELEASED');
    const capacity = await reserveFullIsolationSlot({
      documents, agentId: 'agent-bbbbbbbbbbbbbbbbbbbbbbbbbb', capacity: 1,
      expiresAt: created.expires_at, now: () => clock,
    });
    expect(capacity.allowed).toBe(true);
  });

  it('deletes the credential and the manifest it had written', async () => {
    const { documents, transactions } = abandoning();
    const created = await transactions.create(seedFor(AGENT_ID));
    await documents.set('agents', `${AGENT_ID}__meta`, { agent_id: AGENT_ID });
    await documents.set('agents', `${AGENT_ID}__manifest`, { agent_id: AGENT_ID });

    await transactions.abandon(created.transaction_id);

    expect(await documents.get('agents', `${AGENT_ID}__meta`)).toBeUndefined();
    expect(await documents.get('agents', `${AGENT_ID}__manifest`)).toBeUndefined();
  });

  it('changes nothing on a second call', async () => {
    const { documents, transactions, revoked } = abandoning();
    const created = await transactions.create(seedFor(AGENT_ID, 'full_isolation'));
    await documents.set('dedicated_resources', AGENT_ID, {
      agent_id: AGENT_ID, status: 'CREATING',
      created: [{
        kind: 'service_account', name: 'projects/p/serviceAccounts/sa-op-abcdefghijkl@p.test',
        created_at: created.created_at, deleted_at: null,
      }],
      created_at: created.created_at, expires_at: created.expires_at, last_error: null,
    } satisfies DedicatedResourceRecord);

    await transactions.abandon(created.transaction_id);
    const afterFirst = await documents.get<DedicatedResourceRecord>('dedicated_resources', AGENT_ID);
    // A resource exists, so the slot is not free yet: Lifecycle deletes it, and the
    // GCP quota it occupies is not returned before that (DEC-IAC-23).
    expect(afterFirst!.status).toBe('FAILED');

    await transactions.abandon(created.transaction_id);
    expect(await documents.get('dedicated_resources', AGENT_ID)).toEqual(afterFirst);
    expect(revoked).toHaveLength(1);
  });

  it('leaves a completed transaction alone', async () => {
    const { transactions, revoked } = abandoning();
    const created = await transactions.create(seedFor(AGENT_ID));
    await transactions.advance(created.transaction_id, 'PROVISIONING');
    await transactions.advance(created.transaction_id, 'COMPLETED');

    const result = await transactions.abandon(created.transaction_id);
    expect(result!.status).toBe('COMPLETED');
    expect(revoked).toEqual([]);
  });
});
