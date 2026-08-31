import { describe, expect, it } from 'vitest';
import {
  compile, EXTENDED_VALIDATION_CODES, PROTOCOL_VIOLATION_CODES,
  protocolValidationEventSchema, SchemaValidationError, VIOLATION_MESSAGES,
  type ProtocolValidationEvent,
} from '../src/index.js';

const valid: ProtocolValidationEvent = {
  code: 'delegation_mismatch', outcome: 'fail', validation_name: 'delegation_check',
  human_subject: 'user-1', agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
  occurred_at: '2026-01-01T00:00:00Z', path: 'agent-op:/xaa/token', trace_id: 't-1',
};

describe('protocol validation codes', () => {
  it('has exactly twenty-two codes in the fixed order', () => {
    expect(PROTOCOL_VIOLATION_CODES).toHaveLength(22);
    expect(PROTOCOL_VIOLATION_CODES[0]).toBe('invalid_signature');
    expect(PROTOCOL_VIOLATION_CODES.at(-1)).toBe('code_already_used');
    expect(new Set(PROTOCOL_VIOLATION_CODES).size).toBe(22);
  });

  it('refresh token reuse is not in the twenty-two', () => {
    expect(PROTOCOL_VIOLATION_CODES).not.toContain('refresh_token_reuse' as never);
    expect(EXTENDED_VALIDATION_CODES).toEqual(['refresh_token_reuse']);
  });

  it('event schema rejects raw token fields', () => {
    const assertEvent = compile(protocolValidationEventSchema);
    expect(() => assertEvent(valid)).not.toThrow();
    expect(() => assertEvent({ ...valid, access_token: 'eyJ...' })).toThrow(SchemaValidationError);
    expect(() => assertEvent({ ...valid, dpop_proof: 'eyJ...' })).toThrow(SchemaValidationError);
  });

  it('rejects a code outside the two lists', () => {
    const assertEvent = compile(protocolValidationEventSchema);
    expect(() => assertEvent({ ...valid, code: 'made_up_code' })).toThrow(SchemaValidationError);
  });

  it('has a message for every code', () => {
    for (const code of [...PROTOCOL_VIOLATION_CODES, ...EXTENDED_VALIDATION_CODES]) {
      expect(VIOLATION_MESSAGES[code]).toBeTruthy();
    }
    expect(Object.keys(VIOLATION_MESSAGES)).toHaveLength(23);
  });
});
