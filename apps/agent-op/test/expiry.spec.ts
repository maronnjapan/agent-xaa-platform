import { describe, expect, it } from 'vitest';
import { createDpopProof } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE } from '@xaa/contracts';
import { agentExpiryCheck, verifyAgentState } from '../src/idjag/verify-agent-state.js';
import { AGENT_OP_BASE, clientAssertion, createFixture, exchange, type Fixture } from './helpers.js';

const registration = (status: string, expiresAt: string) => ({
  status, expires_at: expiresAt,
} as never);

async function subjectTokenCall(fixture: Fixture) {
  const path = '/xaa/subject-token';
  return fixture.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      DPoP: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}${path}`, keyPair: fixture.dpopKeyPair, now: fixture.now }),
    },
    body: new URLSearchParams({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(fixture, { path }),
    }).toString(),
  });
}

describe('agent state gate', () => {
  it('rejects an agent whose expires_at has passed', () => {
    const now = new Date();
    expect(() => verifyAgentState(registration('ACTIVE', new Date(now.getTime() - 1).toISOString()), now)).toThrow();
    expect(agentExpiryCheck(registration('ACTIVE', new Date(now.getTime() - 1).toISOString()), now)).toBe('expired');
  });

  it('rejects REVOKED, EXPIRED and QUARANTINED with invalid_grant', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 60_000).toISOString();
    for (const status of ['REVOKED', 'EXPIRED', 'QUARANTINED']) {
      expect(() => verifyAgentState(registration(status, future), now)).toThrow();
      expect(agentExpiryCheck(registration(status, future), now)).toBe('not_active');
    }
  });

  it('accepts ACTIVE and EXPIRING', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 60_000).toISOString();
    for (const status of ['ACTIVE', 'EXPIRING']) {
      expect(() => verifyAgentState(registration(status, future), now)).not.toThrow();
      expect(agentExpiryCheck(registration(status, future), now)).toBe('ok');
    }
  });

  it('applies no leeway around expires_at', () => {
    const now = new Date();
    expect(() => verifyAgentState(registration('ACTIVE', now.toISOString()), now)).toThrow();
  });

  it('rejects token exchange once the registration has expired', async () => {
    const fixture = await createFixture({ registration: { expires_at: new Date(Date.now() - 10_000).toISOString() } });
    const response = await exchange(fixture);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects subject-token reissue for the same agent', async () => {
    const fixture = await createFixture({ registration: { expires_at: new Date(Date.now() - 10_000).toISOString() } });
    const response = await subjectTokenCall(fixture);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('uses the same gate on both endpoints for a quarantined agent', async () => {
    const fixture = await createFixture({ registration: { status: 'QUARANTINED' } });
    expect((await exchange(fixture)).status).toBe(400);
    expect((await subjectTokenCall(fixture)).status).toBe(400);
  });
});
