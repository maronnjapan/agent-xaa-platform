import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_EVENT_FIELDS, EVENT_FIELDS, IDENTITY_EVENT_FIELDS, LogFieldsMissing,
  createLogger, expectLogFields, expectNoRawToken,
} from '../src/index.js';

const CONTEXT = { request_id: 'req-1', trace_id: 'trace-1', agent_id: null, human_subject: 'testuser' };

function capture(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  createLogger('resource-docs-api', 'resource_api', (line) => lines.push(line)).info('resource_api.access', CONTEXT, fields);
  return lines[0]!;
}

const ACCESS_FIELDS = {
  tool_id: 'internal.document.list', operation: 'list', http_method: 'GET',
  resource: 'https://resource-docs-api.test', response_status: 200, outcome: 'success', latency_ms: 42,
};

describe('event contracts', () => {
  it('every identity event declares its required fields', () => {
    expect(Object.keys(IDENTITY_EVENT_FIELDS)).toHaveLength(7);
    for (const fields of Object.values(IDENTITY_EVENT_FIELDS)) expect(fields.length).toBeGreaterThan(0);
  });
  it('authz ai event has no free text field', () => expect(CONTROL_PLANE_EVENT_FIELDS['authz_ai.infer']).not.toContain('description'));

  it('covers the ten rows of the log table between the two halves', () => {
    expect(Object.keys(EVENT_FIELDS)).toHaveLength(12);
    for (const fields of Object.values(EVENT_FIELDS)) expect(new Set(fields).size).toBe(fields.length);
  });
});

/**
 * The helper each application's own logging spec calls. It is checked here, against the
 * table it reads, so an application spec that goes green is going green for the right
 * reason.
 */
describe('expectLogFields', () => {
  it('accepts a line that carries every declared field', () => {
    expect(expectLogFields(capture(ACCESS_FIELDS), 'resource_api.access')).toMatchObject(ACCESS_FIELDS);
  });

  it('names the field that is missing rather than only failing', () => {
    const incomplete = Object.fromEntries(
      Object.entries(ACCESS_FIELDS).filter(([key]) => key !== 'latency_ms'),
    );
    expect(() => expectLogFields(capture(incomplete), 'resource_api.access')).toThrow(/latency_ms/);
  });

  it('refuses an event name no table declares', () => {
    expect(() => expectLogFields(capture(ACCESS_FIELDS), 'made.up')).toThrow(LogFieldsMissing);
  });

  it('refuses a line whose value begins with eyJ', () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig';
    // Under a name the deny list does not know: the shared logger still blanks it on
    // shape alone, which is the first of the two defences (T-SEC-02).
    expect(JSON.parse(capture({ ...ACCESS_FIELDS, note: jwt })).fields.note).toBe('[REDACTED]');

    // The second: an application that assembled its own line, bypassing the logger.
    const smuggled = JSON.stringify({
      ...JSON.parse(capture(ACCESS_FIELDS)),
      fields: { ...ACCESS_FIELDS, note: jwt },
    });
    expect(() => expectLogFields(smuggled, 'resource_api.access')).toThrow(/raw token/);
    expect(() => expectNoRawToken({ nested: [{ deep: jwt }] }, 'x')).toThrow(LogFieldsMissing);
    expect(() => expectNoRawToken({ nested: [{ deep: 'doc_12' }] }, 'x')).not.toThrow();
  });
});
