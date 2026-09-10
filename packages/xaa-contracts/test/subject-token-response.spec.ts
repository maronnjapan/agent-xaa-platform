import { describe, expect, it } from 'vitest';
import {
  SUBJECT_TOKEN_DEFAULT_EXPIRES_IN, SUBJECT_TOKEN_FORBIDDEN_FIELDS, TOKEN_TYPE_ID_TOKEN,
  buildSubjectTokenResponse, findForbiddenSubjectTokenFields, readSubjectToken,
  readSubjectTokenExpiresIn,
} from '../src/index.js';

/**
 * REQ-05-051. Agent OP writes this body and Agent Runtime reads it; the pair is the
 * whole point of the module, so the tests are written as a round trip rather than as
 * two independent shape assertions that could both be right about different shapes.
 */
describe('the subject-token response', () => {
  it('round-trips between the OP that builds it and the Runtime that reads it', () => {
    const response = buildSubjectTokenResponse({ idToken: 'header.payload.sig', expiresIn: 900 });

    expect(Object.keys(response).sort()).toEqual(['expires_in', 'subject_token', 'subject_token_type']);
    expect(readSubjectToken({ ...response })).toBe('header.payload.sig');
    expect(readSubjectTokenExpiresIn({ ...response })).toBe(900);
    expect(response.subject_token_type).toBe(TOKEN_TYPE_ID_TOKEN);
  });

  it('defaults the lifetime when Human IdP does not report one', () => {
    expect(buildSubjectTokenResponse({ idToken: 'a.b.c' }).expires_in).toBe(SUBJECT_TOKEN_DEFAULT_EXPIRES_IN);
    expect(readSubjectTokenExpiresIn({ expires_in: 0 })).toBeUndefined();
    expect(readSubjectTokenExpiresIn({ expires_in: '900' })).toBeUndefined();
  });

  it('does not read a token out of anything but this response', () => {
    // The shape the Runtime read for as long as the two sides disagreed.
    expect(readSubjectToken({ id_token: 'a.b.c' })).toBeUndefined();
    expect(readSubjectToken({ subject_token: 'a.b.c' })).toBeUndefined();
    expect(readSubjectToken({ subject_token: '', subject_token_type: TOKEN_TYPE_ID_TOKEN })).toBeUndefined();
    expect(readSubjectToken({
      subject_token: 'a.b.c', subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    })).toBeUndefined();
  });

  it('names the credentials that must never ride along', () => {
    expect([...SUBJECT_TOKEN_FORBIDDEN_FIELDS]).toEqual(['access_token', 'refresh_token']);
    expect(findForbiddenSubjectTokenFields(buildSubjectTokenResponse({ idToken: 'a.b.c' }))).toEqual([]);
    expect(findForbiddenSubjectTokenFields({ access_token: 'at', refresh_token: 'rt' }))
      .toEqual(['access_token', 'refresh_token']);
    // Present but empty still counts: the OP handed it over either way.
    expect(findForbiddenSubjectTokenFields({ refresh_token: undefined })).toEqual(['refresh_token']);
  });
});
