import { describe, expect, it } from 'vitest';
import { redact } from '../src/index.js';

describe('redaction', () => {
  it('redacts nine secret kinds', () => {
    const value = 'raw-secret-value';
    const output = redact({ access_token: value, id_jag: value, dpop_proof: value, subject_token: value, actor_token: value, refresh_token: value, private_key: value, client_secret: value, authorization_code: value });
    expect(JSON.stringify(output)).not.toContain(value);
  });
  it('redacts jwt in unknown field name', () => expect(redact({ note: 'eyJhbGciOiJFUzI1NiJ9.e30.signature' })).toEqual({ note: '[REDACTED]' }));
  it('keeps short low entropy strings', () => expect(redact(['doc_12', 'pending'])).toEqual(['doc_12', 'pending']));
  it('truncates deep object at depth 8', () => {
    let value: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) value = { child: value };
    expect(JSON.stringify(redact(value))).toContain('[TRUNCATED]');
  });
});
