import { describe, expect, it } from 'vitest';
import { AGENT_URN_PREFIX, PLATFORM_CLIENT_ID } from '@xaa/contracts';
import { ID_JAG_CLAIM_KEYS, OPTIONAL_SUBJECT_CLAIM_KEYS } from '../src/idjag/build-claims.js';
import {
  createFixture, decodePayload, exchange, HUMAN_SUBJECT, ISSUER, subjectToken,
} from './helpers.js';

/** docs 05 §6.4, read off a grant this OP actually issued rather than off a builder. */
async function issuedClaims(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<Record<string, unknown>> {
  const response = await exchange(fixture);
  expect(response.status).toBe(200);
  const body = await response.json() as { access_token: string };
  return decodePayload(body.access_token);
}

describe('ID-JAG claim set', () => {
  it('sub is the human subject and act.sub is the agent urn', async () => {
    const fixture = await createFixture();
    const claims = await issuedClaims(fixture);
    expect(claims.sub).toBe(HUMAN_SUBJECT);
    expect((claims.act as { sub: string }).sub).toBe(`${AGENT_URN_PREFIX}${fixture.agentId}`);
    // RULE-46: the agent is never the subject, and the human is never the actor.
    expect(claims.sub).not.toBe((claims.act as { sub: string }).sub);
    expect(String(claims.sub).startsWith(AGENT_URN_PREFIX)).toBe(false);
  });

  it('client_id is always agent-platform', async () => {
    const fixture = await createFixture();
    expect((await issuedClaims(fixture)).client_id).toBe(PLATFORM_CLIENT_ID);
    expect((await issuedClaims(fixture)).client_id).not.toBe(fixture.agentId);
  });

  /**
   * DEC-ID-03 / DEV-15: Agent OP names the Human IdP's issuer, byte for byte. Building
   * it from this service's own hostname is what makes a Resource AS see two issuers.
   */
  it('iss equals the human-idp issuer byte-exact', async () => {
    const fixture = await createFixture();
    const claims = await issuedClaims(fixture);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.iss).not.toBe(fixture.registration.agent_id);
    expect(String(claims.iss)).not.toContain('agent-op');
  });

  it('isolation_level is copied from the registration', async () => {
    for (const level of ['standard', 'full_isolation'] as const) {
      const fixture = await createFixture({ registration: { isolation_level: level } });
      expect((await issuedClaims(fixture)).isolation_level).toBe(level);
    }
  });

  it('claim set contains no keys outside the fixed list', async () => {
    const fixture = await createFixture();
    const claims = await issuedClaims(fixture);
    const allowed = new Set<string>([...ID_JAG_CLAIM_KEYS, ...OPTIONAL_SUBJECT_CLAIM_KEYS, 'cnf']);
    expect(Object.keys(claims).filter((key) => !allowed.has(key))).toEqual([]);
    for (const key of ID_JAG_CLAIM_KEYS) expect(Object.keys(claims)).toContain(key);

    // auth_time only rides along when the subject_token carried it.
    const withAuthTime = await createFixture();
    const response = await exchange(withAuthTime, {
      form: { subject_token: await subjectToken(withAuthTime, { auth_time: 1_700_000_000 }) },
    });
    const carried = decodePayload((await response.json() as { access_token: string }).access_token);
    expect(carried.auth_time).toBe(1_700_000_000);
    expect(Object.keys(carried).filter((key) => !allowed.has(key))).toEqual([]);
  });
});
