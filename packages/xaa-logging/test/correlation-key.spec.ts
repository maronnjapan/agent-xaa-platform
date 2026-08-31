import { describe, expect, it } from 'vitest';
import { attachCorrelationKeys, tokenFingerprint } from '../src/index.js';

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
describe('correlation keys', () => {
  it('same token yields same fingerprint', () => expect(tokenFingerprint('token')).toBe(tokenFingerprint('token')));
  it('different tokens yield different fingerprints', () => expect(tokenFingerprint('token-a')).not.toBe(tokenFingerprint('token-b')));
  it('fingerprint length is 16 regardless of input length', () => {
    expect(tokenFingerprint('x'.repeat(20))).toHaveLength(16);
    expect(tokenFingerprint('x'.repeat(4000))).toHaveLength(16);
  });
  it('extracts jti kid typ jkt from id-jag', () => {
    const token = `${segment({ alg: 'ES256', typ: 'oauth-id-jag+jwt', kid: 'key-1' })}.${segment({ jti: 'j1', cnf: { jkt: 'thumb' } })}.sig`;
    expect(attachCorrelationKeys({ id_jag: token })).toMatchObject({ id_jag: '[REDACTED]', id_jag_jti: 'j1', id_jag_kid: 'key-1', id_jag_typ: 'oauth-id-jag+jwt', id_jag_jkt: 'thumb' });
  });
});
