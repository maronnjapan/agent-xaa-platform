import { describe, expect, it } from 'vitest';
import { LEDGER_FIELDS } from '../src/log/issuance-ledger.js';
import { createFixture, exchange } from './helpers.js';

/**
 * T-SEC-15 / REQ-09-022. Every ID-JAG the platform issues is recorded before it is
 * handed over.
 *
 * The reconciliation runs from the Resource AS side: a redemption with no ledger row is
 * a token this OP did not issue. That only means something if the ledger is complete —
 * an issuance that succeeded while its record was lost would look exactly like a
 * forgery, so the write is not allowed to fail quietly.
 */
describe('the ID-JAG issuance ledger', () => {
  it('does not issue when ledger write fails', async () => {
    const fixture = await createFixture({
      writeLedger: () => { throw new Error('ledger unavailable'); },
    });

    const response = await exchange(fixture);

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json() as Record<string, unknown>;
    // No token in the answer: the caller gets an error rather than a credential the
    // platform has no record of.
    expect(body.access_token).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  it('records thirteen fields, in the envelope the sink keeps', async () => {
    const fixture = await createFixture();
    expect((await exchange(fixture)).status).toBe(200);

    expect(fixture.ledgerLogs).toHaveLength(1);
    const line = JSON.parse(fixture.ledgerLogs[0]!) as { log_source: string; event: string; fields: Record<string, unknown> };
    expect(line.log_source).toBe('agent_op');
    expect(Object.keys(line.fields).sort()).toEqual([...LEDGER_FIELDS].sort());
    expect(line.fields.typ).toBe('oauth-id-jag+jwt');
    expect(line.fields.jti).toEqual(expect.any(String));
    expect(line.fields.kid).toBe('op-shared-1');
  });

  it('writes the record before the response, not after it', async () => {
    const order: string[] = [];
    const fixture = await createFixture({ writeLedger: () => { order.push('ledger'); } });
    const response = await exchange(fixture);
    order.push('response');
    expect(response.status).toBe(200);
    expect(order).toEqual(['ledger', 'response']);
  });

  it('carries no compact JWS on the ledger line', async () => {
    const fixture = await createFixture();
    await exchange(fixture);
    expect(fixture.ledgerLogs.join('\n')).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
