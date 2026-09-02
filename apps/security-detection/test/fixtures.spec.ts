import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { LOG_SOURCES, expectNoRawToken } from '@xaa/logging';
import { CLASS_UID, normalizeEntries } from '../src/normalize/index.js';

const fixtureDir = new URL('./fixtures/logs/', import.meta.url);

async function load(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`${name}.json`, fixtureDir), 'utf8')) as Record<string, unknown>;
}

/**
 * The ten log sources, as their producers actually write them.
 *
 * The rest of the suite builds events from `logEntry()`, which is convenient and which
 * agrees with itself by construction — so a converter that reads a field name no producer
 * emits passes every one of those tests. These fixtures carry the field names the eight
 * applications and two shared writers put on the wire (docs 09 §2), so a rename on either
 * side lands here rather than in production silence.
 */
describe('the ten log source fixtures', () => {
  it('has one fixture per log source', async () => {
    const files = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json')).sort();
    expect(files).toEqual([...LOG_SOURCES].map((source) => `${source}.json`).sort());
  });

  it('all ten fixtures pass schema validation', async () => {
    const entries = await Promise.all(LOG_SOURCES.map((source) => load(source)));
    const result = normalizeEntries(entries);
    expect(result.counters.schema_violation_total).toBe(0);
    expect(result.counters.unmapped_source_total).toBe(0);
    expect(result.events).toHaveLength(LOG_SOURCES.length);
    expect(result.events.map((event) => event.class_uid).sort((left, right) => left - right))
      .toEqual([...LOG_SOURCES].map((source) => CLASS_UID[source]).sort((left, right) => left - right));
  });

  /**
   * T-SEC-05. The five Identity rows carry the values a token was built from — issuer,
   * subject, jti, kid, thumbprint — and never the token. `eyJ` is what a compact JWS
   * always starts with, so one prefix check over every value is the whole property.
   */
  it('carries no value that begins with eyJ in any identity log line', async () => {
    const identity = ['human_idp', 'agent_op', 'agent_op_idp_connection', 'google_bridge', 'native_resource_as'];
    for (const source of identity) {
      const entry = await load(source);
      expect(() => expectNoRawToken(entry, source)).not.toThrow();
      const values = Object.values(entry.fields as Record<string, unknown>);
      expect(values.filter((value) => typeof value === 'string' && value.startsWith('eyJ'))).toEqual([]);
    }
  });

  it('reads the resource API refusal status the producer writes', async () => {
    // `logApiAccess` writes `response_status` and `http_method`; reading `status` and
    // `method` left every refusal looking like its severity.
    const denied = await load('resource_api');
    (denied.fields as Record<string, unknown>).response_status = 403;
    const event = normalizeEntries([denied]).events[0]!;
    expect(event.api.status).toBe('403');
    expect(event.api.method).toBe('GET');
  });

  it('keeps the fields a rule reads out of the Agent OP and Runtime lines', async () => {
    const [op, runtime] = normalizeEntries([await load('agent_op'), await load('agent_runtime')]).events;
    expect(op!.attributes.requested_scope).toBe('docs.read');
    expect(op!.attributes.requested_audience).toBe('https://resource-docs-as.test');
    expect(op!.attributes.issued_jti).toBe('jti-1');
    expect(runtime!.attributes.agent_age_seconds).toBe(120);
    expect(runtime!.attributes.expires_at).toBe('2026-01-02T12:00:03.000Z');
    expect(runtime!.attributes.tool_id).toBe('internal.document.list');
  });
});
