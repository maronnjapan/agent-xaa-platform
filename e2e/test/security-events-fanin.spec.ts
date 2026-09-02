import { describe, expect, it } from 'vitest';
import { createInProcessBus } from '@xaa/security-detection/src/ingest/subscriber';
import { createSecurityHarness } from '@xaa/security-detection/src/testing/harness';
import { LOG_SOURCES, createLogger, type LogSource } from '@xaa/logging';

/**
 * The twelve deploy units that write onto the security channel.
 *
 * REQ-01-025 names eight applications; REQ-09-023 needs the Resource AS side too,
 * because the ledger reconciliation starts from what a Resource AS accepted. So the two
 * Resource AS and the two Resource API services are counted as well, and every one of
 * them is a separate Cloud Run service with its own revision — which is exactly what
 * makes this worth pinning: a unit whose lines carry no `log_source` is dropped by the
 * sink's filter and is invisible rather than merely quiet.
 */
const DEPLOY_UNITS: ReadonlyArray<{ app: string; source: LogSource }> = [
  { app: 'human-idp', source: 'human_idp' },
  { app: 'authorization', source: 'authz_ai' },
  { app: 'authorization', source: 'policy_engine' },
  { app: 'provisioner', source: 'provisioner' },
  { app: 'shared-agent-op', source: 'agent_op' },
  { app: 'shared-agent-op', source: 'agent_op_idp_connection' },
  { app: 'google-bridge', source: 'google_bridge' },
  { app: 'resource-docs-as', source: 'native_resource_as' },
  { app: 'resource-finance-as', source: 'native_resource_as' },
  { app: 'resource-docs-api', source: 'resource_api' },
  { app: 'resource-finance-api', source: 'resource_api' },
  { app: 'agent-runtime', source: 'agent_runtime' },
];

/** One line from one unit, written through the shared logger it would use in production. */
function lineFrom(unit: { app: string; source: LogSource }, index: number): unknown {
  const lines: string[] = [];
  createLogger(unit.app, unit.source, (line) => lines.push(line)).info('fanin_probe', {
    request_id: `req-${index}`, trace_id: `trace-${index}`,
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz', human_subject: 'testuser',
  }, { unit: unit.app });
  // Cloud Logging wraps it; the sink forwards the envelope, and the detector unwraps it.
  return { insertId: `log-${index}`, resource: { type: 'cloud_run_revision' }, jsonPayload: JSON.parse(lines[0]!) };
}

describe('the security-logs fan-in', () => {
  it('twelve deploy units reach the topic', async () => {
    const bus = createInProcessBus();
    const received: unknown[] = [];
    const harness = createSecurityHarness();
    bus.subscribe(async (payload) => {
      received.push(payload);
      await harness.runOnce([payload]);
    });

    for (const [index, unit] of DEPLOY_UNITS.entries()) await bus.publish(lineFrom(unit, index));

    expect(DEPLOY_UNITS).toHaveLength(12);
    expect(received).toHaveLength(12);
  });

  it('every unit writes a log_source the sink keeps and the detector can dispatch on', () => {
    for (const [index, unit] of DEPLOY_UNITS.entries()) {
      const wrapped = lineFrom(unit, index) as { jsonPayload: { log_source: string } };
      // The sink's filter is `jsonPayload.log_source != ""`, and the normaliser picks a
      // converter by the same field.
      expect(wrapped.jsonPayload.log_source, unit.app).not.toBe('');
      expect(LOG_SOURCES, unit.app).toContain(wrapped.jsonPayload.log_source);
    }
    // Twelve units, ten sources: two apps run two writers each.
    expect(new Set(DEPLOY_UNITS.map((unit) => unit.source)).size).toBe(LOG_SOURCES.length);
  });

  it('nothing travels back: the detector reaches only the Lifecycle Manager', async () => {
    const harness = createSecurityHarness();
    await harness.runOnce(DEPLOY_UNITS.map((unit, index) => lineFrom(unit, index)));
    expect(harness.transitions).toHaveLength(0);
  });
});
