import { describe, expect, it } from 'vitest';
import { decodeJwsUnverified } from '@xaa/crypto';
import {
  AGENT_CLIENT_AUTH_ASSERTION_TYPE, JWT_TYP, buildSubjectTokenResponse,
} from '@xaa/contracts';
import {
  SUBJECT_ENDPOINT_PATH, SUBJECT_REFRESH_MARGIN_MS, UnexpectedSubjectResponse, fetchSubjectToken,
} from '../src/tokens/subject-token.js';
import { AGENT_OP, fakeIdToken, json, subjectTokenResponse, testContext, testHttp } from './helpers.js';

/**
 * T-RUN-10 / DEC-ID-19. The human's ID Token is asked for, never handed in: the Agent
 * OP holds the IdP connection, so the agent keeps working after the browser session
 * that created it is gone — and the Runtime never holds anything that could renew it.
 */
describe('the subject token', () => {
  it('reads the token out of the response the Agent OP actually sends', async () => {
    const context = await testContext();
    const idToken = fakeIdToken();
    // Byte for byte what /xaa/subject-token answers (REQ-05-051), built by the OP's
    // own function. Reading `id_token` here instead cost every execution its first
    // tool call: `subject token response has no id_token`, and the Job ended having
    // done nothing.
    const { http } = testHttp(context, () => json(buildSubjectTokenResponse({ idToken })));

    await expect(fetchSubjectToken(context, http)).resolves.toBe(idToken);
    expect(context.tokens.get('subject')).toBe(idToken);
  });

  it('fails when the response has no subject_token', async () => {
    const context = await testContext();
    // The shape the Runtime used to expect. Nothing sends it, and taking it would
    // hide the next drift rather than report it.
    const { http } = testHttp(context, () => json({ id_token: fakeIdToken() }));

    await expect(fetchSubjectToken(context, http)).rejects.toThrow(UnexpectedSubjectResponse);
    expect(context.tokens.get('subject')).toBeUndefined();
  });

  it('fails when the token under subject_token is not an ID Token', async () => {
    const context = await testContext();
    const { http } = testHttp(context, () => json({
      subject_token: fakeIdToken(), subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    }));

    await expect(fetchSubjectToken(context, http)).rejects.toThrow(UnexpectedSubjectResponse);
    expect(context.tokens.get('subject')).toBeUndefined();
  });

  it('fails when response contains refresh_token', async () => {
    const context = await testContext();
    const { http, calls } = testHttp(context, () => json({ ...subjectTokenResponse(), refresh_token: 'r-1' }));

    await expect(fetchSubjectToken(context, http)).rejects.toThrow(UnexpectedSubjectResponse);
    // Nothing from that answer is kept, not even the part that was asked for.
    expect(context.tokens.get('subject')).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain('r-1');

    const withAccessToken = testHttp(context, () => json({ ...subjectTokenResponse(), access_token: 'a-1' }));
    await expect(fetchSubjectToken(context, withAccessToken.http)).rejects.toThrow(UnexpectedSubjectResponse);
  });

  it('refetches when cached token is within 60s of exp', async () => {
    const context = await testContext();
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    const expSeconds = Math.floor(start / 1000) + 3600;
    const { http, calls } = testHttp(context, () => json(subjectTokenResponse(expSeconds)));

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
    const { http, calls } = testHttp(context, () => json(subjectTokenResponse()));
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
