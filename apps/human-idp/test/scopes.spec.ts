import { describe, expect, it } from 'vitest';
import { CLIENT_ALLOWED_SCOPES, findUnregisteredScope, SUPPORTED_SCOPES } from '../src/config/scopes.js';

describe('registered scopes', () => {
  it('fixes the seven supported scopes', () => {
    expect([...SUPPORTED_SCOPES]).toEqual(['openid', 'profile', 'offline_access', 'workdef:submit', 'agent:provision', 'agent:revoke', 'agent:operate']);
  });

  const cases = [
    ['profile', 'automation-app', true],
    ['profile', 'agent-platform', false],
    ['workdef:submit', 'automation-app', true],
    ['workdef:submit', 'agent-platform', false],
    ['agent:provision', 'automation-app', true],
    ['agent:provision', 'agent-platform', false],
    ['agent:revoke', 'automation-app', true],
    ['agent:revoke', 'agent-platform', false],
    ['agent:operate', 'automation-app', true],
    ['agent:operate', 'agent-platform', false],
  ] as const;

  for (const [scope, clientId, allowed] of cases) {
    it(`${allowed ? 'allows' : 'rejects'} ${scope} for ${clientId}`, () => {
      expect(findUnregisteredScope(clientId, ['openid', scope])).toBe(allowed ? undefined : scope);
    });
  }

  it('rejects an unknown operation scope for every client', () => {
    for (const clientId of Object.keys(CLIENT_ALLOWED_SCOPES)) {
      expect(findUnregisteredScope(clientId, ['openid', 'agent:destroy'])).toBe('agent:destroy');
    }
  });

  it('gives agent-platform offline_access and automation-app none', () => {
    expect(findUnregisteredScope('agent-platform', ['openid', 'offline_access'])).toBeUndefined();
    expect(findUnregisteredScope('automation-app', ['openid', 'offline_access'])).toBe('offline_access');
  });
});
