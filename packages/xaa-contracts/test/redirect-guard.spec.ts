import { describe, expect, it } from 'vitest';
import { assertNoTokenInRedirect, FORBIDDEN_REDIRECT_KEYS, RedirectGuardError } from '../src/redirect-guard.js';

describe('the redirect guard', () => {
  it('refuses every forbidden key', () => {
    for (const key of FORBIDDEN_REDIRECT_KEYS) {
      expect(() => assertNoTokenInRedirect(`https://app.test/back?${key}=value`)).toThrow(RedirectGuardError);
    }
    expect(FORBIDDEN_REDIRECT_KEYS).toHaveLength(6);
  });

  it('refuses #access_token=... in the fragment as well as in the query', () => {
    expect(() => assertNoTokenInRedirect('https://app.test/back#access_token=abc')).toThrow(RedirectGuardError);
    expect(() => assertNoTokenInRedirect('https://app.test/back#a=1&refresh_token=abc')).toThrow(RedirectGuardError);
  });

  it('refuses a token-shaped value even under an allowed key', () => {
    expect(() => assertNoTokenInRedirect('https://app.test/back?code=eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig'))
      .toThrow(RedirectGuardError);
  });

  it('matches key names without regard to case', () => {
    expect(() => assertNoTokenInRedirect('https://app.test/back?Access_Token=x')).toThrow(RedirectGuardError);
  });

  it('permits the parameters a redirect is supposed to carry', () => {
    expect(() => assertNoTokenInRedirect('https://app.test/back?transaction_id=abc&code=xyz')).not.toThrow();
    expect(() => assertNoTokenInRedirect('https://app.test/failed?transaction_id=abc&reason=invalid_state')).not.toThrow();
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertNoTokenInRedirect('/relative/path')).toThrow(RedirectGuardError);
  });
});
