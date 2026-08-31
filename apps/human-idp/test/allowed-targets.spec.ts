import { describe, expect, it } from 'vitest';
import { ALLOWED_TARGETS, INVALID_TARGET_DESCRIPTION, isAllowedTarget } from '../src/config/allowed-targets.js';

describe('audience allow list', () => {
  it('accepts each registered target for automation-app', () => {
    for (const target of ALLOWED_TARGETS['automation-app']!) expect(isAllowedTarget('automation-app', [target])).toBe(true);
  });

  it('rejects an unregistered audience', () => {
    expect(isAllowedTarget('automation-app', ['unknown-app'])).toBe(false);
  });

  it('rejects two audiences in one request', () => {
    expect(isAllowedTarget('automation-app', ['agent-provisioner', 'lifecycle-manager'])).toBe(false);
  });

  it('rejects any audience for agent-platform', () => {
    expect(isAllowedTarget('agent-platform', ['agent-provisioner'])).toBe(false);
    expect(isAllowedTarget('agent-platform', undefined)).toBe(true);
  });

  it('never names the requested audience in the description', () => {
    expect(INVALID_TARGET_DESCRIPTION).not.toMatch(/agent-provisioner|unknown-app/);
  });
});
