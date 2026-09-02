import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createLogger } from '@xaa/logging';
import { createSecurityHarness, logEntry } from '@xaa/security-detection/src/testing/harness';
import { describeViolations, scanSecrets } from '../../src/scan-secrets.js';

const ARTIFACT = new URL('../../artifacts/logs.jsonl', import.meta.url).pathname;

const RAW_ACCESS_TOKEN =
  'eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiJ1c2VyLTEiLCJqdGkiOiJhdC0xIn0.c2lnbmF0dXJl';
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIBVwIBADAN\n-----END PRIVATE KEY-----';

/** Everything the platform's writers put on the security channel during this run. */
function collected(): string[] {
  const lines: string[] = [];
  const write = (line: string) => lines.push(line);
  const context = {
    request_id: 'req-1', trace_id: 'trace-1',
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz', human_subject: 'testuser',
  };

  // One writer per log source, each handed the values a leak would travel in.
  createLogger('human-idp', 'human_idp', write).info('idp_authenticate', context, {
    client_id: 'agent-platform', access_token: RAW_ACCESS_TOKEN, code: 'authcode-1',
  });
  createLogger('shared-agent-op', 'agent_op', write).info('token_exchange', context, {
    subject_token: RAW_ACCESS_TOKEN, actor_token: RAW_ACCESS_TOKEN, client_assertion: RAW_ACCESS_TOKEN,
  });
  createLogger('resource-docs-as', 'native_resource_as', write).info('resource_as.redeem', context, {
    assertion: RAW_ACCESS_TOKEN, private_key: PRIVATE_KEY,
  });
  createLogger('google-bridge', 'google_bridge', write).info('bridge_token', context, {
    refresh_token: 'refresh-value', client_secret: 'shhh', note: RAW_ACCESS_TOKEN,
  });
  createLogger('agent-runtime', 'agent_runtime', write).info('runtime.tool_call', context, {
    tool_id: 'internal.document.list', dpop_proof: RAW_ACCESS_TOKEN,
  });
  return lines;
}

/**
 * T-SEC-10 / REQ-09-015. The regression test for every writer at once.
 *
 * The redactor is unit-tested, so this is not about whether it works — it is about
 * whether anything reached Cloud Logging around it. The values below are handed to the
 * shared logger under the names a leak would actually use, and the scan runs over what
 * came out. There is no branch that skips this when BigQuery is unavailable: a check
 * that can be silently skipped is a check nobody notices losing.
 */
describe('no raw secret reaches the log', () => {
  it('reports no violation over everything this run wrote', async () => {
    const violations = scanSecrets(collected());
    expect(describeViolations(violations)).toBe('');
    expect(violations).toHaveLength(0);
  });

  it('reports no violation over a detection run', async () => {
    const harness = createSecurityHarness();
    await harness.runOnce([logEntry({ fields: { access_token: RAW_ACCESS_TOKEN, result: 'issued' } })]);
    expect(scanSecrets(harness.logs)).toHaveLength(0);
  });

  it('scans the collected artifact when the pipeline produced one', async () => {
    // `scripts/collect-logs.ts` writes this from BigQuery on a deployed run; locally
    // there is nothing to read and the in-process lines above are the whole corpus.
    const lines = await readFile(ARTIFACT, 'utf8').then((text) => text.split('\n'), () => null);
    if (lines === null) {
      expect(scanSecrets(collected())).toHaveLength(0);
      return;
    }
    expect(describeViolations(scanSecrets(lines))).toBe('');
  });
});
