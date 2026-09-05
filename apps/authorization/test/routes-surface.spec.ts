import { describe, expect, it } from 'vitest';
import { compile, PROTOCOL_VALIDATION_EVENT, SchemaValidationError } from '@xaa/contracts';
import { authorizationDecisionResponseSchema, DECISION_RESPONSE_KEYS, ROUTES } from '../src/routes/index.js';
import { loadConfig } from '../src/config.js';
import { createAuthzHarness, testConfig } from './helpers.js';

/** Everything Terraform injects, so a test can take exactly one thing away. */
const COMPLETE_ENV: NodeJS.ProcessEnv = {
  ISSUER: testConfig.issuer, JWKS_URL: testConfig.jwksUrl, AUTHZ_AUDIENCE: testConfig.authzAudience,
  PUBLIC_BASE_URL: testConfig.authzPublicBaseUrl, PROJECT_ID: 'p', REGION: 'r',
  VERTEX_MODEL: 'gemini-2.5-flash', VERTEX_LOCATION: 'us-central1',
  LIFECYCLE_MANAGER_URL: 'https://lifecycle.test', ACTIVITY_TOPIC: 'agent-activity-stream',
  TAXONOMY_VERSION: 'v1', AGENT_MAX_LIFETIME_SECONDS: '86400',
};

describe('route surface', () => {
  it('exposes no GET besides livez', () => {
    expect(ROUTES.filter((route) => route.method === 'GET' && route.path !== '/livez')).toEqual([]);
  });

  it('declares exactly the four documented routes', () => {
    expect(ROUTES.map((route) => route.path)).toEqual([
      '/livez', '/v1/authorization/decisions', '/api/work-requests', '/internal/events/human-permission-changed',
    ]);
  });

  it('fixes the response to five top-level keys', () => {
    const assertResponse = compile(authorizationDecisionResponseSchema);
    const body = {
      decision_id: 'dec_00000000-0000-4000-8000-000000000000',
      status: 'decided', effective_capabilities: [],
      security_profile: { risk_score: 0, isolation_level: 'standard', reasons: [] },
      denied: [],
    };
    expect(() => assertResponse(body)).not.toThrow();
    expect(() => assertResponse({ ...body, capability_taxonomy: [] })).toThrow(SchemaValidationError);
    expect(DECISION_RESPONSE_KEYS).toHaveLength(5);
  });

  it('allows only the two decision statuses', () => {
    const assertResponse = compile(authorizationDecisionResponseSchema);
    expect(() => assertResponse({
      decision_id: 'dec_00000000-0000-4000-8000-000000000000', status: 'pending',
      effective_capabilities: [], security_profile: { risk_score: 0, isolation_level: 'standard', reasons: [] }, denied: [],
    })).toThrow(SchemaValidationError);
  });

  it('refuses to start without ISSUER', () => {
    expect(() => loadConfig(COMPLETE_ENV)).not.toThrow();
    expect(() => loadConfig({ ...COMPLETE_ENV, ISSUER: undefined })).toThrow(/ISSUER/);
    expect(() => loadConfig({ ...COMPLETE_ENV, VERTEX_MODEL: undefined })).toThrow(/VERTEX_MODEL/);
  });

  /**
   * `createApp` takes an already-checked config, so the environment is checked on the
   * one path that reaches it: `server.ts` builds the dependencies and only then calls
   * `createApp`. A missing ISSUER stops there — the app is never constructed, rather
   * than constructed with an issuer nobody set.
   */
  it('never reaches createApp when ISSUER is unset', async () => {
    const { createRuntimeDeps } = await import('../src/runtime.js');
    await expect(createRuntimeDeps({ ...COMPLETE_ENV, ISSUER: undefined })).rejects.toThrow(/ISSUER/);
  });
});

/**
 * The guard refuses correctly whether or not anyone is listening; what this fixes is
 * that somebody is. Security Detection's whole input is these lines, so a Control Plane
 * that refuses silently looks, from the detector's side, like a platform where nothing
 * was ever refused (T-SEC-12).
 */
describe('a refusal leaves a record', () => {
  it('writes one validation line when the token does not verify', async () => {
    const harness = await createAuthzHarness();

    const response = await harness.fetch('/api/work-requests', {
      method: 'POST',
      headers: { Authorization: 'DPoP not-a-token', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    const lines = harness.logs.map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });
    const validations = lines.filter((line) => line.event === PROTOCOL_VALIDATION_EVENT);
    expect(validations).toHaveLength(1);
    // `code` is redacted by name; `validation` is the value the detector reads.
    expect(validations[0]!.fields.validation).toBe('invalid_signature');
    expect(validations[0]!.fields.outcome).toBe('fail');
    expect(validations[0]!.fields.path).toBe('authorization:/api');
  });
});
