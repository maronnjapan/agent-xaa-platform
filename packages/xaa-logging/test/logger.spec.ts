import { describe, expect, it } from 'vitest';
import { assertLogEntry, createLogger, LOG_SOURCES } from '../src/index.js';

describe('structured logger', () => {
  it('emits all four required keys even when null', () => {
    let line = '';
    createLogger('test', 'agent_runtime', (value) => { line += value; }).info('test.event', { request_id: 'r', trace_id: 't', agent_id: null, human_subject: null });
    expect(JSON.parse(line)).toMatchObject({ request_id: 'r', trace_id: 't', agent_id: null, human_subject: null });
  });
  it('rejects entry missing trace_id', () => expect(() => assertLogEntry({})).toThrow());
  it('log source has exactly ten values', () => expect(LOG_SOURCES).toHaveLength(10));
});
