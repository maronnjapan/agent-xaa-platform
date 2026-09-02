import { describe, expect, it } from 'vitest';
import { PROTOCOL_VIOLATION_CODES } from '../src/protocol-violation.js';
import {
  CONTROL_PLANE_VALIDATION_CODES, VALIDATION_NAME_TO_CODE, validationPath,
} from '../src/validation-hooks.js';

/**
 * T-SEC-12 / REQ-05-022. The eight Control Plane checks, and what each is reported as.
 *
 * The names are prose and the codes are what a saved query keys on, so the two are kept
 * together: a middleware that invented a ninth name, or that reported two checks under
 * one code, would leave a detection matching on something nothing emits.
 */
describe('the control plane validation hooks', () => {
  it('maps eight validation names to codes', () => {
    const entries = Object.entries(VALIDATION_NAME_TO_CODE);
    expect(entries).toHaveLength(8);
    expect(entries).toEqual([
      ['invalid signature', 'invalid_signature'],
      ['expired token', 'expired_token'],
      ['audience mismatch', 'audience_mismatch'],
      ['invalid scope', 'invalid_scope'],
      ['invalid DPoP proof', 'invalid_dpop_proof'],
      ['replayed DPoP proof', 'replayed_dpop_proof'],
      ['DPoP key binding mismatch', 'dpop_key_binding_mismatch'],
      ['human_subject mismatch', 'human_subject_mismatch'],
    ]);
    // One code per check: two names sharing a code would make the two indistinguishable.
    expect(new Set(entries.map(([, code]) => code)).size).toBe(8);
  });

  it('names only codes the fixed enumeration already has', () => {
    for (const code of Object.values(VALIDATION_NAME_TO_CODE)) {
      expect(PROTOCOL_VIOLATION_CODES).toContain(code);
    }
    expect([...CONTROL_PLANE_VALIDATION_CODES]).toEqual(Object.values(VALIDATION_NAME_TO_CODE));
  });

  it('builds a path from the route template, never from the request url', () => {
    expect(validationPath('authorization', '/v1/authorization/decisions'))
      .toBe('authorization:/v1/authorization/decisions');
    // Nothing here can carry a query string, because nothing here reads one.
    expect(validationPath('provisioner', '/api')).not.toContain('?');
  });
});
