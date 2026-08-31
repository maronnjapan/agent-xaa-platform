import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const routesDir = new URL('../src/oidc/routes/', import.meta.url).pathname;

describe('revocation stays per refresh token', () => {
  it('revocation route never calls revokeConsentAndTokens', () => {
    for (const file of ['revocation.ts', 'token.ts', 'userinfo.ts', 'introspection.ts']) {
      expect(readFileSync(`${routesDir}${file}`, 'utf8')).not.toContain('revokeConsentAndTokens');
    }
  });

  it('revocation route does not delete browser sessions', () => {
    const source = readFileSync(`${routesDir}revocation.ts`, 'utf8');
    expect(source).not.toContain('browserSessionStore');
    expect(source).not.toContain('idp_sessions');
  });

  it('carries no bulk revoke-by-subject route', () => {
    const source = readFileSync(`${routesDir}revocation.ts`, 'utf8');
    expect(source).not.toMatch(/revokeAllForSubject|revokeBySubject/);
  });
});
