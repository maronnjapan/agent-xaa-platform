import { describe, expect, it } from 'vitest';
import { decodeJwsUnverified } from '@xaa/crypto';
import { AGENT_CLIENT_AUTH_ASSERTION_TYPE, JWT_TYP } from '@xaa/contracts';
import {
  SUBJECT_ENDPOINT_PATH, SUBJECT_REFRESH_MARGIN_MS, UnexpectedSubjectResponse, fetchSubjectToken,
} from '../src/tokens/subject-token.js';
import { AGENT_OP, fakeIdToken, json, testContext, testHttp } from './helpers.js';

/**
 * T-RUN-10 / DEC-ID-19. The human's ID Token is asked for, never handed in: the Agent
 * OP holds the IdP connection, so the agent keeps working after the browser session
 * that created it is gone — and the Runtime never holds anything that could renew it.
 */
describe('the subject token', () => {
  it('fails when response contains refresh_token', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, () => json({ id_token: fakeIdToken(), refresh_token: 'r-1' }));

    await expect(fetchSubjectToken(context, http)).rejects.toThrow(UnexpectedSubjectResponse);
    // Nothing from that answer is kept, not even the part that was asked for.
    expect(context.tokens.get('subject')).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain('r-1');

    const withAccessToken = testHttp(context, () => json({ id_token: fakeIdToken(), access_token: 'a-1' }));
    await expect(fetchSubjectToken(context, withAccessToken.http)).rejects.toThrow(UnexpectedSubjectResponse);
  });

  it('refetches when cached token is within 60s of exp', async () => {
    const context = await testContext();
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    const expSeconds = Math.floor(start / 1000) + 3600;
    const { http, calls } = testHttp(context, () => json({ id_token: fakeIdToken(expSeconds) }));

    await fetchSubjectToken(context, http, start);
    expect(calls).toHaveLength(1);

    // Comfortably inside the token's life: the cached one is used.
    await fetchSubjectToken(context, http, start + 1_000_000);
    expect(calls).toHaveLength(1);

    // Inside the last minute: a token that may expire mid-exchange is not good enough.
    await fetchSubjectToken(context, http, expSeconds * 1000 - (SUBJECT_REFRESH_MARGIN_MS - 1_000));
    expect(calls).toHaveLength(2);
    expect(SUBJECT_REFRESH_MARGIN_MS).toBe(60_000);
  });

  it('sends dpop proof without ath', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, () => json({ id_token: fakeIdToken() }));
    await fetchSubjectToken(context, http);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${AGENT_OP}${SUBJECT_ENDPOINT_PATH}`);
    const proof = decodeJwsUnverified((call.init.headers as Record<string, string>).DPoP!);
    expect(proof.header.typ).toBe(JWT_TYP.DPOP_PROOF);
    expect(proof.payload.htm).toBe('POST');
    expect(proof.payload.htu).toBe(`${AGENT_OP}${SUBJECT_ENDPOINT_PATH}`);
    // There is no Access Token yet, so there is nothing for `ath` to bind to.
    expect(proof.payload).not.toHaveProperty('ath');

    // The body is the two client-authentication fields and nothing else.
    const body = new URLSearchParams(String(call.init.body));
    expect([...body.keys()].sort()).toEqual(['client_assertion', 'client_assertion_type']);
    expect(body.get('client_assertion_type')).toBe(AGENT_CLIENT_AUTH_ASSERTION_TYPE);
    expect(decodeJwsUnverified(body.get('client_assertion')!).header.typ).toBe(JWT_TYP.CLIENT_ASSERTION);
  });
});
