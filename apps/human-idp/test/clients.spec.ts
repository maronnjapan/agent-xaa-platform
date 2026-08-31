import { describe, expect, it } from 'vitest';
import { createClientRegistry } from '../src/config/clients.js';
import { testEnv } from './helpers.js';

describe('client registry', () => {
  it('registers exactly automation-app and agent-platform', () => {
    expect([...createClientRegistry(testEnv).keys()].sort()).toEqual(['agent-platform', 'automation-app']);
  });

  it('registry has no other agent-prefixed client', () => {
    const clients = [...createClientRegistry(testEnv).keys()];
    expect(clients.filter((id) => id.startsWith('agent-'))).toEqual(['agent-platform']);
  });

  it('does not register example-client', () => {
    expect(createClientRegistry(testEnv).has('example-client')).toBe(false);
  });

  it('rejects http redirect_uri in gcp mode', () => {
    expect(() => createClientRegistry({ ...testEnv, storeMode: 'gcp', automationAppRedirectUri: 'http://localhost:3000/callback' }))
      .toThrow(/https/);
  });

  it('takes each redirect uri from the environment, one per client', () => {
    const registry = createClientRegistry(testEnv);
    expect(registry.get('automation-app')?.redirectUris).toEqual([testEnv.automationAppRedirectUri]);
    expect(registry.get('agent-platform')?.redirectUris).toEqual([testEnv.agentOpCallbackUri]);
  });

  it('registers both clients for the refresh_token grant with client_secret_basic', () => {
    for (const client of createClientRegistry(testEnv).values()) {
      expect(client.grantTypes).toEqual(['authorization_code', 'refresh_token']);
      expect(client.tokenEndpointAuthMethod).toBe('client_secret_basic');
      expect(client.clientType).toBe('confidential');
      expect(client.defaultMaxAge).toBe(3600);
    }
  });
});
