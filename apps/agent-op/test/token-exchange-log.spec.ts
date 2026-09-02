import { describe, expect, it } from 'vitest';
import { createTrace, emitTokenExchangeLog } from '../src/log/token-exchange-log.js';
import { buildLedgerRecord, emitIssuanceLedger, LEDGER_FIELDS } from '../src/log/issuance-ledger.js';
import { createFixture, exchange, subjectToken } from './helpers.js';

/** docs 09 §2: the fixed shape, on the rejected path as much as the issued one. */
const EXCHANGE_FIELDS = ['op_runtime_id', 'isolation_kind', 'requested_audience', 'requested_resource', 'requested_scope',
  'subject_token_iss', 'subject_token_aud', 'subject_token_sub', 'actor_token_sub', 'actor_token_jti',
  'delegation_match', 'dpop_result', 'issued_jti', 'issued_kid', 'issued_jkt', 'expiry_check', 'error_code'];

describe('token exchange log', () => {
  it('emits exactly one record per request', async () => {
    const fixture = await createFixture();
    await exchange(fixture);
    await exchange(fixture);
    expect(fixture.exchangeLogs).toHaveLength(2);
  });

  it('emits all seventeen fields on success and on a RULE-49 violation', async () => {
    const ok = await createFixture();
    await exchange(ok);
    const line = JSON.parse(ok.exchangeLogs[0]!) as Record<string, unknown>;
    // The envelope the Log Sink filters on and the normalizer dispatches on: without
    // it the record never reaches Security Detection at all (T-SEC-05).
    expect(line.log_source).toBe('agent_op');
    expect(line.event).toBe('token_exchange');
    const success = line.fields as Record<string, unknown>;
    for (const field of EXCHANGE_FIELDS) expect(Object.keys(success)).toContain(field);
    expect(success.error_code).toBeNull();
  });

  it('RULE-49 violation emits all seventeen fields with delegation_match=false', async () => {
    const bad = await createFixture({ registration: { human_subject: 'user-B' } });
    await exchange(bad, { form: { subject_token: await subjectToken(bad, { sub: 'user-A' }) } });
    const failure = (JSON.parse(bad.exchangeLogs[0]!) as { fields: Record<string, unknown> }).fields;
    for (const field of EXCHANGE_FIELDS) expect(Object.keys(failure)).toContain(field);
    expect(failure.delegation_match).toBe(false);
    expect(failure.error_code).toBe('invalid_grant');
  });

  it('rejects a trace that somehow carries a compact JWS', () => {
    const trace = createTrace({ revision: 'r', kind: 'shared' });
    trace.requested_audience = 'eyJhbGciOiJFUzI1NiJ9.body.sig';
    expect(() => emitTokenExchangeLog(trace, () => undefined)).toThrow(/compact JWS/);
  });

  it('no log line contains a compact JWS', async () => {
    const fixture = await createFixture();
    await exchange(fixture);
    await exchange(fixture, { form: { audience: 'https://elsewhere.test' } });
    expect(fixture.exchangeLogs.join('\n')).not.toMatch(/eyJ/);
  });
});

describe('ID-JAG issuance ledger', () => {
  const claims = {
    jti: 'j1', iss: 'https://human-idp.test', sub: 'user-1', aud: 'https://docs-as.test',
    resource: 'https://docs-api.test', scope: ['docs.read'], exp: 200, iat: 100,
    act: { sub: 'urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz' },
  };

  it('record contains exactly the thirteen fields', () => {
    const record = buildLedgerRecord(claims, 'op-shared-1', 'agent-abcdefghijklmnopqrstuvwxyz', false);
    expect(Object.keys(record).sort()).toEqual([...LEDGER_FIELDS].sort());
    expect(LEDGER_FIELDS).toHaveLength(13);
    expect(record.typ).toBe('oauth-id-jag+jwt');
    expect(record.dedicated_short_id).toBeNull();
  });

  it('records the short id for a dedicated OP', () => {
    const record = buildLedgerRecord(claims, 'idjag-nopqrstuvwxyz-1', 'agent-abcdefghijklmnopqrstuvwxyz', true);
    expect(record.dedicated_short_id).toBe('opqrstuvwxyz');
  });

  it('record contains no compact JWS', () => {
    expect(() => emitIssuanceLedger({ ...buildLedgerRecord(claims, 'k', 'agent-a', false), sub: 'eyJhbGciOiJFUzI1NiJ9.a.b' }, () => undefined))
      .toThrow(/compact JWS/);
  });

  it('three issuances produce three records with distinct jti', async () => {
    const fixture = await createFixture();
    for (let attempt = 0; attempt < 3; attempt += 1) await exchange(fixture);
    const ids = fixture.ledgerLogs.map((line) => (JSON.parse(line) as { fields: { jti: string } }).fields.jti);
    expect(new Set(ids).size).toBe(3);
    expect(fixture.ledgerLogs.every((line) => {
      const entry = JSON.parse(line) as { event: string; log_source: string };
      return entry.event === 'idjag_issuance' && entry.log_source === 'agent_op';
    })).toBe(true);
  });

  it('a rejected request produces no ledger record', async () => {
    const fixture = await createFixture();
    await exchange(fixture, { form: { scope: 'finance.tx.write' } });
    expect(fixture.ledgerLogs).toHaveLength(0);
  });
});
