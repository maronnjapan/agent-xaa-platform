import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_EVENT_FIELDS, IDENTITY_EVENT_FIELDS } from '../src/index.js';

describe('event contracts', () => {
  it('every identity event declares its required fields', () => {
    expect(Object.keys(IDENTITY_EVENT_FIELDS)).toHaveLength(7);
    for (const fields of Object.values(IDENTITY_EVENT_FIELDS)) expect(fields.length).toBeGreaterThan(0);
  });
  it('authz ai event has no free text field', () => expect(CONTROL_PLANE_EVENT_FIELDS['authz_ai.infer']).not.toContain('description'));
});
