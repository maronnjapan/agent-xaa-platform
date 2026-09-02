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

describe('redaction keeps identifiers readable', () => {
  it('leaves a dotted tool id alone', () => {
    expect(redact({ provisioned_tools: ['internal.document.get', 'stub.calendar.events.list'] }))
      .toEqual({ provisioned_tools: ['internal.document.get', 'stub.calendar.events.list'] });
  });

  it('still redacts a real compact JWS', () => {
    const token = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln';
    expect(redact({ note: token })).toEqual({ note: '[REDACTED]' });
  });

  it('leaves a jti and a thumbprint readable', () => {
    const record = { jti: 'VXJWbjj8qPNvjqw5WeZFKlSWzP2MDxvGtCLr36by-j8', cnf_jkt: 'v9uxeE3Bl-McvkIMOWo19cAn-bwSRjST9kSncra8zfY' };
    expect(redact(record)).toEqual(record);
  });

  it('leaves the flattened Token Exchange identifiers readable (T-SEC-05)', () => {
    // `issued_id_jag.cnf_jkt` flattened to a top-level `issued_jkt`: a real thumbprint
    // is long and high-entropy, so without an identifier-list entry the generic
    // heuristic would have redacted a field the detection SQL is meant to read.
    const record = { issued_kid: 'op-shared-1', issued_jkt: 'v9uxeE3Bl-McvkIMOWo19cAn-bwSRjST9kSncra8zfY', id_jag_sub: 'user-1', id_jag_act: 'urn:agent:one' };
    expect(redact(record)).toEqual(record);
  });
});
