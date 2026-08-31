import { describe, expect, it } from 'vitest';
import schema from '../env.schema.json' with { type: 'json' };
import { ENV_KEYS, EnvValidationError, loadEnv } from '../src/env.js';
import { testEnv } from './helpers.js';

const complete: NodeJS.ProcessEnv = {
  PORT: '8080',
  ISSUER: testEnv.issuer,
  ISSUER_PROFILE: 'direct',
  JWKS_BUCKET: 'xaa-jwks',
  JWKS_PUBLIC_BASE_URL: testEnv.jwksPublicBaseUrl,
  KEY_BUCKET: 'xaa-keys',
  KMS_SSO_KEY_NAME: testEnv.kmsSsoKeyName,
  SIGNER_MODE: 'local',
  STORE_MODE: 'emulator',
  FIRESTORE_DATABASE: 'xaa',
  DPOP_REQUIRED: 'true',
  CLIENT_SECRET_AUTOMATION_APP: 'a',
  CLIENT_SECRET_AGENT_PLATFORM: 'b',
  AUTOMATION_APP_REDIRECT_URI: testEnv.automationAppRedirectUri,
  AGENT_OP_CALLBACK_URI: testEnv.agentOpCallbackUri,
  ACCESS_TOKEN_EXPIRES_IN: '3600',
};

describe('human-idp environment contract', () => {
  it('rejects missing ISSUER', () => {
    const withoutIssuer = { ...complete, ISSUER: undefined };
    expect(() => loadEnv(withoutIssuer)).toThrow(EnvValidationError);
    try { loadEnv(withoutIssuer); } catch (error) { expect((error as EnvValidationError).missingKeys).toEqual(['ISSUER']); }
  });

  it('rejects ISSUER_PROFILE=lb', () => {
    expect(() => loadEnv({ ...complete, ISSUER_PROFILE: 'lb' })).toThrow(EnvValidationError);
  });

  it('names only the key, never the value, when a secret is empty', () => {
    try {
      loadEnv({ ...complete, CLIENT_SECRET_AGENT_PLATFORM: '' });
      expect.unreachable();
    } catch (error) {
      const keys = (error as EnvValidationError).missingKeys;
      expect(keys).toEqual(['CLIENT_SECRET_AGENT_PLATFORM']);
      expect((error as Error).message).not.toContain('agent-platform-secret');
    }
  });

  it('treats an unset DPOP_REQUIRED as true', () => {
    expect(loadEnv({ ...complete, DPOP_REQUIRED: undefined }).dpopRequired).toBe(true);
    expect(loadEnv({ ...complete, DPOP_REQUIRED: 'false' }).dpopRequired).toBe(false);
  });

  it('has a 16-entry required array matching ENV_KEYS', () => {
    expect(schema.required).toHaveLength(16);
    expect([...schema.required].sort()).toEqual([...ENV_KEYS].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...ENV_KEYS].sort());
  });

  it('loads a complete environment', () => {
    expect(loadEnv(complete).issuer).toBe(testEnv.issuer);
  });
});
