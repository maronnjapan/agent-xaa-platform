import { describe, expect, it } from 'vitest';
import { createFixture, exchange, subjectToken } from './helpers.js';

describe('RULE-49 delegation check', () => {
  it('draft 9.7: rejects subject_token(user-A) with actor of an agent delegated by user-B', async () => {
    const fixture = await createFixture({ registration: { human_subject: 'user-B' } });
    const response = await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: 'user-A' }) } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_grant', error_description: 'The delegation relationship could not be verified',
    });
  });

  it('emits exactly one delegation_mismatch activity event', async () => {
    const fixture = await createFixture({ registration: { human_subject: 'user-B' } });
    await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: 'user-A' }) } });
    const violations = fixture.events.filter((event) => event.detail.violation_code === 'delegation_mismatch');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.phase).toBe('security');
    expect(violations[0]!.outcome).toBe('blocked');
  });

  // Title kept verbatim: docs/rule-traceability.md's RULE-49 row names this exact
  // test string, and the field it now checks is `delegation_match` (T-SEC-05).
  it('records delegation_check=true on match', async () => {
    const fixture = await createFixture();
    await exchange(fixture);
    expect((JSON.parse(fixture.exchangeLogs[0]!) as { fields: { delegation_match: boolean } }).fields.delegation_match).toBe(true);
  });

  it('records delegation_match=false on mismatch', async () => {
    const fixture = await createFixture({ registration: { human_subject: 'user-B' } });
    await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: 'user-A' }) } });
    expect((JSON.parse(fixture.exchangeLogs[0]!) as { fields: { delegation_match: boolean } }).fields.delegation_match).toBe(false);
  });

});
