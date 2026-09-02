import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_EVENT_FIELDS } from '@xaa/logging';
import { workDefinitionHash } from '../src/index.js';

const BODY = { purpose: '毎朝の日報を集めて要約する', steps: ['collect', 'summarise'] };

/**
 * T-SEC-06 and REQ-09-014. The Work Definition's prose never leaves the Control Plane;
 * what travels is this hash, under the name `work_definition_hash`. Two runs over the
 * same body must therefore agree, or the same definition would look like two.
 */
describe('work definition hash', () => {
  it('hash is deterministic', async () => {
    const first = await workDefinitionHash(BODY);
    const second = await workDefinitionHash(BODY);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // The value the Authorization AI log carries in place of the text.
    expect(CONTROL_PLANE_EVENT_FIELDS['authz_ai.infer']).toContain('work_definition_hash');
    expect(first).not.toContain('日報');
  });

  it('a different body hashes differently', async () => {
    expect(await workDefinitionHash(BODY)).not.toBe(await workDefinitionHash({ ...BODY, purpose: 'else' }));
  });
});
