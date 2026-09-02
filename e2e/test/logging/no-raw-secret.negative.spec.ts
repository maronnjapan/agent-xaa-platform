import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { scanSecrets } from '../../src/scan-secrets.js';

const RAW_ACCESS_TOKEN =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1c2VyLTEiLCJqdGkiOiJhdC0xIn0.c2lnbmF0dXJl';

/**
 * An application that writes its own line instead of using the shared logger.
 *
 * This is the leak the scan exists for. The redactor lives inside `createLogger`, so a
 * service that assembles JSON and calls `process.stdout.write` itself is past every
 * defence — and it looks entirely ordinary in review. Keeping one here means the scan is
 * known to fail when it should, rather than assumed to.
 */
function leakyApp(write: (line: string) => void): Hono {
  const app = new Hono();
  app.post('/token', async (context) => {
    write(`${JSON.stringify({
      severity: 'INFO', app: 'leaky-fixture', log_source: 'agent_op', event: 'token_exchange',
      request_id: 'req-1', trace_id: 'trace-leak', agent_id: null, human_subject: 'testuser',
      timestamp: '2026-01-01T12:00:00.000Z',
      // Straight onto the line, under a name nothing sanitises.
      fields: { issued: RAW_ACCESS_TOKEN },
    })}\n`);
    return context.json({ ok: true });
  });
  return app;
}

/**
 * T-SEC-10. The negative half: the scan finds a real leak.
 *
 * A regression test that has only ever been green over clean input proves the input was
 * clean, not that the check works.
 */
describe('the secret scan against a leaking fixture', () => {
  it('detects exactly one violation', async () => {
    const lines: string[] = [];
    const app = leakyApp((line) => lines.push(line));

    const response = await app.fetch(new Request('https://leaky.test/token', { method: 'POST' }));
    expect(response.status).toBe(200);

    const violations = scanSecrets(lines);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('compact_jws');
    expect(violations[0]!.app).toBe('leaky-fixture');
    expect(violations[0]!.trace_id).toBe('trace-leak');
  });

  it('detects a deny-list field that was never redacted', () => {
    const line = JSON.stringify({
      severity: 'INFO', app: 'leaky-fixture', log_source: 'agent_op', event: 'refresh',
      request_id: '', trace_id: 'trace-2', agent_id: null, human_subject: null,
      timestamp: '2026-01-01T12:00:00.000Z',
      fields: { refresh_token: 'not-a-jwt-but-still-a-secret' },
    });
    const violations = scanSecrets([line]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'deny_field', field: 'refresh_token' });
  });

  it('accepts the same field once it says [REDACTED]', () => {
    const line = JSON.stringify({
      severity: 'INFO', app: 'agent-op', log_source: 'agent_op', event: 'refresh',
      request_id: '', trace_id: 'trace-3', agent_id: null, human_subject: null,
      timestamp: '2026-01-01T12:00:00.000Z',
      fields: { refresh_token: '[REDACTED]', refresh_token_fingerprint: 'a1b2c3d4e5f60718' },
    });
    expect(scanSecrets([line])).toHaveLength(0);
  });
});
