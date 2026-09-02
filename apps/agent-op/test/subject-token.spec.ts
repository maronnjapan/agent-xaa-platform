import { describe, expect, it } from 'vitest';
import { createFixture, exchange, subjectToken, type Fixture } from './helpers.js';

/**
 * REQ-05-068. The library reports every bad subject_token as invalid_request; docs
 * asks for invalid_grant, so that one case is remapped in the route. The description
 * is one constant string: a caller may not learn from the answer whether it was the
 * signature, the issuer, the audience or the expiry that failed.
 */
async function refuse(fixture: Fixture, token: string): Promise<{ error: string; error_description: string }> {
  const response = await exchange(fixture, { form: { subject_token: token } });
  expect(response.status).toBe(400);
  return await response.json() as { error: string; error_description: string };
}

describe('subject_token verification', () => {
  it('maps subject token failure to invalid_grant', async () => {
    const fixture = await createFixture();
    const tampered = await subjectToken(fixture);
    const body = await refuse(fixture, `${tampered.slice(0, -4)}AAAA`);
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects ID Token with aud=automation-app', async () => {
    const fixture = await createFixture();
    const body = await refuse(fixture, await subjectToken(fixture, { aud: 'automation-app' }));
    expect(body.error).toBe('invalid_grant');
  });

  it('error_description does not vary across signature / iss / aud / exp failures', async () => {
    const fixture = await createFixture();
    const valid = await subjectToken(fixture);
    const now = Math.floor(fixture.now() / 1000);
    const answers = [
      await refuse(fixture, `${valid.slice(0, -4)}AAAA`),
      await refuse(fixture, await subjectToken(fixture, { iss: 'https://another-idp.test' })),
      await refuse(fixture, await subjectToken(fixture, { aud: 'automation-app' })),
      await refuse(fixture, await subjectToken(fixture, { iat: now - 7200, exp: now - 3600 })),
    ];
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]!.error).toBe('invalid_grant');
  });

  /**
   * DEC-ID-20: the subject_token is verified against the `idp-` view of the shared JWK
   * Set. Were the whole set handed over, a JWT this OP signed with its own ID-JAG key
   * would be accepted as the human's ID Token.
   */
  it('rejects a JWT signed with the agent-op signing key as subject_token', async () => {
    const fixture = await createFixture();
    const forged = await subjectToken(fixture, {}, fixture.opSigner);
    const body = await refuse(fixture, forged);
    expect(body.error).toBe('invalid_grant');
  });
});
