import { describe, expect, it } from 'vitest';
import { describeViolations, scanSecrets } from '../../src/scan-secrets.js';

const RAW_ACCESS_TOKEN =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1c2VyLTEiLCJqdGkiOiJhdC0xIn0.c2lnbmF0dXJl';
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIBVwIBADAN\n-----END RSA PRIVATE KEY-----';

function leaking(fields: Record<string, unknown>): string {
  return JSON.stringify({
    severity: 'INFO', app: 'leaky-fixture', log_source: 'agent_op', event: 'token_exchange',
    request_id: 'req-1', trace_id: 'trace-leak', agent_id: null, human_subject: 'testuser',
    timestamp: '2026-01-01T12:00:00.000Z', fields,
  });
}

/**
 * T-SEC-10. What the failure itself is allowed to say.
 *
 * A scan that printed the offending line would put the secret into CI output, an issue
 * comment and everybody's terminal scrollback — turning one leak into several. So the
 * report names where to look and never what it found.
 */
describe('the secret scan report', () => {
  it('error message carries no secret', () => {
    const violations = scanSecrets([leaking({ issued: RAW_ACCESS_TOKEN, private_key: PRIVATE_KEY })]);
    expect(violations.length).toBeGreaterThan(0);

    const message = describeViolations(violations);
    expect(message).not.toMatch(/eyJ/);
    expect(message).not.toContain('PRIVATE KEY');
    expect(message).not.toContain(RAW_ACCESS_TOKEN);
    // What it does say: which check, which writer, which request.
    expect(message).toContain('compact_jws');
    expect(message).toContain('leaky-fixture/token_exchange');
    expect(message).toContain('trace=trace-leak');
    // The violation objects themselves are printed by a failing assertion, so they must
    // be safe too.
    expect(JSON.stringify(violations)).not.toMatch(/eyJ/);
  });

  it('finds a private key that arrived under an unremarkable name', () => {
    const violations = scanSecrets([leaking({ note: PRIVATE_KEY })]);
    expect(violations.map((violation) => violation.rule)).toContain('private_key');
  });

  it('scans a line that is not JSON without throwing', () => {
    expect(scanSecrets([`plain text with ${RAW_ACCESS_TOKEN}`])).toHaveLength(1);
    expect(scanSecrets(['', '   '])).toHaveLength(0);
  });

  it('says nothing for a line the shared logger wrote', () => {
    const clean = JSON.stringify({
      severity: 'INFO', app: 'agent-op', log_source: 'agent_op', event: 'token_exchange',
      request_id: 'req-1', trace_id: 'trace-1', agent_id: null, human_subject: 'testuser',
      timestamp: '2026-01-01T12:00:00.000Z',
      fields: { subject_token: '[REDACTED]', subject_token_fingerprint: 'a1b2c3d4e5f60718' },
    });
    expect(describeViolations(scanSecrets([clean]))).toBe('');
  });
});
