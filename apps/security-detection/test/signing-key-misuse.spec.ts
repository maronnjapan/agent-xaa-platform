import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { JWT_TYP } from '@xaa/contracts';
import {
  BATCH_STATE_COLLECTION, BATCH_STATE_ID, REDEEM_SOURCE, WINDOW_MINUTES,
  runBatch, signingKeyMisuseQuery, type BatchDeps, type MisuseRow, type RuleHitRow,
} from '../src/batch/signing-key-misuse.js';
import { createInternalBatchRoutes } from '../src/routes/internal-batch.js';

const PROJECT = 'demo-project';
const DATASET = 'security_audit';
const NOW = new Date('2026-01-01T12:00:00.000Z');

function row(overrides: Partial<MisuseRow> = {}): MisuseRow {
  return {
    occurred_at: '2026-01-01T11:55:00.000Z',
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    human_subject: 'testuser',
    trace_id: 'trace-1',
    received_jti: 'jti-1',
    received_kid: 'idjag-abcdefghijkl-1',
    received_typ: JWT_TYP.ID_JAG,
    ledger_jti: null,
    ...overrides,
  };
}

function deps(rows: MisuseRow[]): BatchDeps & { inserted: RuleHitRow[]; queries: string[] } {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'security-detection');
  const inserted: RuleHitRow[] = [];
  const queries: string[] = [];
  return {
    documents, inserted, queries,
    query: async (sql) => { queries.push(sql); return rows; },
    insertRuleHits: async (batch) => { inserted.push(...batch); },
  };
}

/**
 * T-SEC-15. The reconciliation the Scheduler starts every five minutes.
 */
describe('the signing key misuse batch', () => {
  it('joins from resource as side', () => {
    const sql = signingKeyMisuseQuery(PROJECT, DATASET);
    // The left table is the log stream filtered to what a Resource AS redeemed; the
    // ledger appears only on the right of a LEFT JOIN.
    expect(sql).toMatch(/FROM `demo-project\.security_audit\.run_googleapis_com_stdout` AS redeem/);
    expect(sql).toContain(`log_source = '${REDEEM_SOURCE.log_source}'`);
    expect(sql).toContain(`event = '${REDEEM_SOURCE.event}'`);
    expect(sql).toMatch(/LEFT JOIN `demo-project\.security_audit\.id_jag_ledger` AS ledger/);
    // A join that started from the OP's own log could never see a token it did not issue.
    expect(sql).not.toContain('agent_op.token_exchange');
    expect(sql.indexOf('FROM')).toBeLessThan(sql.indexOf('id_jag_ledger'));
  });

  it('asks for exactly the last ten minutes', async () => {
    const batch = deps([]);
    let bound: { window_start: string; window_end: string } | undefined;
    batch.query = async (_sql, params) => { bound = params; return []; };
    await runBatch(NOW, batch, PROJECT, DATASET);
    expect(bound).toEqual({
      window_start: '2026-01-01T11:50:00.000Z',
      window_end: '2026-01-01T12:00:00.000Z',
    });
    expect(WINDOW_MINUTES).toBe(10);
  });

  it('unrecorded jti becomes a critical rule hit', async () => {
    const batch = deps([row({ ledger_jti: null })]);
    const hits = await runBatch(NOW, batch, PROJECT, DATASET);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ detection_code: 'signing_key_misuse', level: 'CRITICAL' });
    expect(JSON.parse(hits[0]!.detail)).toMatchObject({ received_jti: 'jti-1', ledger_jti: null });
    expect(batch.inserted).toHaveLength(1);
  });

  it('wrong typ becomes a critical rule hit even with a ledger row', async () => {
    const batch = deps([row({ received_jti: 'jti-2', ledger_jti: 'jti-2', received_typ: 'at+jwt' })]);
    const hits = await runBatch(NOW, batch, PROJECT, DATASET);
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.detail).received_typ).toBe('at+jwt');
  });

  it('same jti is not detected twice', async () => {
    const batch = deps([row()]);
    await runBatch(NOW, batch, PROJECT, DATASET);
    // The five-minute schedule over a ten-minute window sees the same row again.
    const second = await runBatch(new Date(NOW.getTime() + 5 * 60_000), batch, PROJECT, DATASET);
    expect(second).toHaveLength(0);
    expect(batch.inserted).toHaveLength(1);

    const state = await batch.documents.get<{ seen: Array<{ jti: string }> }>(BATCH_STATE_COLLECTION, BATCH_STATE_ID);
    expect(state!.seen.map((entry) => entry.jti)).toEqual(['jti-1']);
  });

  it('forgets a jti once it is far outside any window it could reappear in', async () => {
    const batch = deps([row()]);
    await runBatch(NOW, batch, PROJECT, DATASET);
    // An hour later the redemption cannot be returned by any window, so remembering it
    // would only grow the state document forever.
    batch.query = async () => [];
    await runBatch(new Date(NOW.getTime() + 2 * 60 * 60_000), batch, PROJECT, DATASET);
    const state = await batch.documents.get<{ seen: unknown[] }>(BATCH_STATE_COLLECTION, BATCH_STATE_ID);
    expect(state!.seen).toEqual([]);
  });
});

describe('the internal batch route', () => {
  const app = (verify?: (token: string) => Promise<string | null>) => createInternalBatchRoutes({
    ...(verify ? { verifyScheduler: verify } : {}),
    runSigningKeyMisuse: async () => [row()],
    now: () => NOW.getTime(),
  });

  const post = (instance: ReturnType<typeof app>, token?: string) => instance.fetch(new Request(
    'https://security-detection.test/internal/batch/signing-key-misuse',
    { method: 'POST', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
  ));

  it('refuses every caller but the scheduler', async () => {
    const guarded = app(async (token) => (token === 'scheduler' ? 'sa-scheduler@test' : null));
    expect((await post(guarded)).status).toBe(403);
    expect((await post(guarded, 'someone-else')).status).toBe(403);
    expect((await post(guarded, 'scheduler')).status).toBe(200);
  });

  it('stays closed when no caller check is configured', async () => {
    expect((await post(app(), 'scheduler')).status).toBe(403);
  });
});
