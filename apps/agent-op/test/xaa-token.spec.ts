import { describe, expect, it } from 'vitest';
import { jwkThumbprint } from '@xaa/crypto';
import { AGENT_URN_PREFIX } from '@xaa/contracts';
import {
  createFixture, decodeHeader, decodePayload, exchange, DOCS_AS_ISSUER, DOCS_API_RESOURCE, HUMAN_SUBJECT, ISSUER,
} from './helpers.js';

async function issued(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const response = await exchange(fixture);
  expect(response.status).toBe(200);
  const body = await response.json() as { access_token: string; issued_token_type: string; token_type: string; expires_in: number; scope: string };
  return { body, claims: decodePayload(body.access_token), header: decodeHeader(body.access_token) };
}

describe('POST /xaa/token issues an ID-JAG', () => {
  it('returns a signed grant with the fixed claim set', async () => {
    const fixture = await createFixture();
    const { body, claims, header } = await issued(fixture);
    expect(body.issued_token_type).toBe('urn:ietf:params:oauth:token-type:id-jag');
    expect(body.token_type).toBe('N_A');
    expect(header.typ).toBe('oauth-id-jag+jwt');
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe('op-shared-1');
    expect(claims.iss).toBe(ISSUER);
    expect(claims.sub).toBe(HUMAN_SUBJECT);
    expect(claims.aud).toBe(DOCS_AS_ISSUER);
    expect(claims.resource).toBe(DOCS_API_RESOURCE);
    expect(claims.client_id).toBe('agent-platform');
    expect((claims.act as { sub: string }).sub).toBe(`${AGENT_URN_PREFIX}${fixture.agentId}`);
    expect(claims.isolation_level).toBe('standard');
  });

  it('binds cnf.jkt to the DPoP proof key', async () => {
    const fixture = await createFixture();
    const { claims } = await issued(fixture);
    expect((claims.cnf as { jkt: string }).jkt).toBe(await jwkThumbprint(fixture.dpopKeyPair.publicJwk));
  });

  it('carries no claim outside the fixed list', async () => {
    const fixture = await createFixture();
    const { claims } = await issued(fixture);
    const allowed = new Set(['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat', 'scope', 'resource', 'act', 'isolation_level', 'cnf', 'auth_time', 'acr', 'amr']);
    expect(Object.keys(claims).filter((key) => !allowed.has(key))).toEqual([]);
  });

  it('caps exp at the agent expiry and reports expires_in as exp - iat', async () => {
    const fixture = await createFixture();
    const { body, claims } = await issued(fixture);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(body.expires_in).toBe(300);
  });

  it('shortens the grant when the agent expires sooner than the lifetime', async () => {
    const fixture = await createFixture({ registration: { expires_at: new Date(Date.now() + 60_000).toISOString() } });
    const { body, claims } = await issued(fixture);
    expect(Number(claims.exp) - Number(claims.iat)).toBeGreaterThanOrEqual(59);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(60);
    expect(body.expires_in).toBe(Number(claims.exp) - Number(claims.iat));
  });

  it('refuses to issue once the agent has expired', async () => {
    const fixture = await createFixture({ registration: { expires_at: new Date(Date.now() - 1000).toISOString() } });
    const response = await exchange(fixture);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('writes exactly one exchange log and one ledger record per issuance', async () => {
    const fixture = await createFixture();
    await issued(fixture);
    expect(fixture.exchangeLogs).toHaveLength(1);
    expect(fixture.ledgerLogs).toHaveLength(1);
    const trace = (JSON.parse(fixture.exchangeLogs[0]!) as { fields: Record<string, unknown> }).fields;
    for (const field of ['op_runtime_id', 'isolation_kind', 'requested_audience', 'requested_resource', 'requested_scope',
      'subject_token_iss', 'subject_token_aud', 'subject_token_sub', 'actor_token_sub', 'actor_token_jti',
      'delegation_match', 'dpop_result', 'issued_jti', 'issued_kid', 'issued_jkt', 'expiry_check', 'error_code']) {
      expect(Object.keys(trace)).toContain(field);
    }
    expect(trace.delegation_match).toBe(true);
    expect(trace.error_code).toBeNull();
    expect(fixture.exchangeLogs.join()).not.toMatch(/eyJ/);
    expect(fixture.ledgerLogs.join()).not.toMatch(/eyJ/);
  });

  it('writes no ledger record for a rejected request', async () => {
    const fixture = await createFixture();
    await exchange(fixture, { form: { audience: 'https://elsewhere.test' } });
    expect(fixture.ledgerLogs).toHaveLength(0);
    expect(fixture.exchangeLogs).toHaveLength(1);
  });

  it('gives three issuances three distinct jti values', async () => {
    const fixture = await createFixture();
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt += 1) ids.add(String((await issued(fixture)).claims.jti));
    expect(ids.size).toBe(3);
  });
});
