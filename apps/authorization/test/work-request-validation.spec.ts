import { describe, expect, it } from 'vitest';
import { validateWorkRequest, WorkRequestRejected } from '../src/validation/work-request.js';

const valid = { purpose: '予定整理', description: '当日の予定を整理する', requested_lifetime_hours: 8 };
const MAX_HOURS = 24;

function codeOf(body: unknown): string {
  try {
    validateWorkRequest(body, MAX_HOURS);
    return 'accepted';
  } catch (error) {
    return (error as WorkRequestRejected).code;
  }
}

describe('Business Work Request validation', () => {
  it('accepts the five permitted fields', () => {
    expect(codeOf({ ...valid, human_subject: 'testuser', constraints: { external_message_send: false } })).toBe('accepted');
  });

  it('refuses a body that names permissions', () => {
    expect(codeOf({ ...valid, effective_capabilities: ['finance.payment.approve'] })).toBe('authorization_field_not_allowed');
    for (const field of ['capabilities', 'scopes', 'resources', 'isolation_level', 'tools']) {
      expect(codeOf({ ...valid, [field]: ['x'] })).toBe('authorization_field_not_allowed');
    }
  });

  it('reports an unknown field distinctly', () => {
    expect(codeOf({ ...valid, foo: 1 })).toBe('unexpected_field');
  });

  it('prefers the permission objection when a body has both problems', () => {
    expect(codeOf({ ...valid, foo: 1, effective_capabilities: ['x'] })).toBe('authorization_field_not_allowed');
  });

  it('bounds the requested lifetime at both ends', () => {
    expect(codeOf({ ...valid, requested_lifetime_hours: 0 })).toBe('invalid_request');
    expect(codeOf({ ...valid, requested_lifetime_hours: 999 })).toBe('invalid_request');
    expect(codeOf({ ...valid, requested_lifetime_hours: MAX_HOURS })).toBe('accepted');
  });

  it('accepts only the known constraint key', () => {
    expect(codeOf({ ...valid, constraints: { external_message_send: true } })).toBe('accepted');
    expect(codeOf({ ...valid, constraints: { max_amount: 1 } })).toBe('invalid_request');
  });

  it('requires purpose, description and lifetime', () => {
    expect(codeOf({ description: 'x', requested_lifetime_hours: 1 })).toBe('invalid_request');
    expect(codeOf({ purpose: 'x', requested_lifetime_hours: 1 })).toBe('invalid_request');
    expect(codeOf({ purpose: 'x', description: 'y' })).toBe('invalid_request');
  });

  it('refuses a non-object body', () => {
    expect(codeOf(null)).toBe('invalid_request');
    expect(codeOf([valid])).toBe('invalid_request');
  });
});
