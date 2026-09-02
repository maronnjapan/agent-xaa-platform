import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createStageLogger } from '../src/telemetry/stage-log.js';

const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';
const NOW = Date.parse('2026-01-01T12:00:10.000Z');
/** The container came up ten seconds ago; the agent was registered an hour ago. */
const CONTAINER_STARTED_AT = Date.parse('2026-01-01T12:00:00.000Z');
const REGISTERED_AT = new Date(NOW - 3600_000).toISOString();

function emitOnce(createdAt: string): Record<string, unknown> {
  const lines: string[] = [];
  const logger = createStageLogger({
    executionId: 'exec-1', agentId: AGENT_ID, taskId: 'task-1',
    createdAt, expiresAt: '2026-01-02T12:00:00.000Z',
    now: () => NOW, write: (line) => lines.push(line),
  });
  logger.emit('resource_api', { tool_id: 'internal.document.list', outcome: 'success' });
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/**
 * T-SEC-06. The lifetime rules read `agent_age_seconds` and nothing else, so where the
 * number comes from is the whole property: a Cloud Run container is replaced whenever
 * the platform feels like it, and an age measured from process start would reset to
 * zero at exactly the moment a long-lived agent became worth noticing.
 */
describe('the Agent Runtime tool call log', () => {
  it('agent age comes from registration created_at', () => {
    const line = emitOnce(REGISTERED_AT);
    expect(line.agent_age_seconds).toBe(3600);
    // The container has been up for ten seconds; the age does not say ten.
    expect(Math.round((NOW - CONTAINER_STARTED_AT) / 1000)).toBe(10);
    expect(line.agent_age_seconds).not.toBe(10);
  });

  it('reads no container clock at all', async () => {
    const source = await readFile(new URL('../src/telemetry/stage-log.ts', import.meta.url), 'utf8');
    for (const forbidden of ['process.uptime', 'REVISION_START', 'os.uptime']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('carries the expiry the lifetime rule compares against', () => {
    const line = emitOnce(REGISTERED_AT);
    expect(line.expires_at).toBe('2026-01-02T12:00:00.000Z');
    expect(line.span_id).toEqual(expect.any(String));
  });
});
