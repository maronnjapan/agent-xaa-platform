import { describe, expect, it } from 'vitest';
import { capExp, LIFETIME_EXHAUSTED } from '../src/idjag/cap-exp.js';

const now = new Date('2026-03-01T00:00:00Z');
const iat = Math.floor(now.getTime() / 1000);
const claims = { iat, exp: iat + 300, cnf: { jkt: 'thumb' } };

describe('capping the grant lifetime', () => {
  it('exp - iat equals 60 when expires_at is 60 seconds away', () => {
    const capped = capExp(claims, new Date(now.getTime() + 60_000), now, 300);
    expect(Number(capped.exp) - iat).toBe(60);
  });

  it('exp - iat equals 300 when expires_at is 600 seconds away', () => {
    const capped = capExp(claims, new Date(now.getTime() + 600_000), now, 300);
    expect(Number(capped.exp) - iat).toBe(300);
  });

  it('returns invalid_grant when expires_at is in the past', () => {
    expect(() => capExp(claims, new Date(now.getTime() - 1000), now, 300)).toThrow(LIFETIME_EXHAUSTED);
  });

  it('returns invalid_grant when expires_at is exactly now', () => {
    expect(() => capExp(claims, now, now, 300)).toThrow(LIFETIME_EXHAUSTED);
  });

  it('keeps iat untouched', () => {
    expect(capExp(claims, new Date(now.getTime() + 600_000), now, 300).iat).toBe(iat);
  });

  it('refuses to cap without an iat', () => {
    expect(() => capExp({ cnf: { jkt: 'thumb' } }, new Date(now.getTime() + 600_000), now, 300)).toThrow(/iat/);
  });
});
