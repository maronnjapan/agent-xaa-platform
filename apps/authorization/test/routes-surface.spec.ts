import { describe, expect, it } from 'vitest';
import { compile, SchemaValidationError } from '@xaa/contracts';
import { authorizationDecisionResponseSchema, DECISION_RESPONSE_KEYS, ROUTES } from '../src/routes/index.js';
import { loadConfig } from '../src/config.js';
import { testConfig } from './helpers.js';

describe('route surface', () => {
  it('exposes no GET besides healthz', () => {
    expect(ROUTES.filter((route) => route.method === 'GET' && route.path !== '/healthz')).toEqual([]);
  });

  it('declares exactly the four documented routes', () => {
    expect(ROUTES.map((route) => route.path)).toEqual([
      '/healthz', '/v1/authorization/decisions', '/api/work-requests', '/internal/events/human-permission-changed',
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
    const complete: NodeJS.ProcessEnv = {
      ISSUER: testConfig.issuer, JWKS_URL: testConfig.jwksUrl, AUTHZ_AUDIENCE: testConfig.authzAudience,
      PUBLIC_BASE_URL: testConfig.authzPublicBaseUrl, PROJECT_ID: 'p', REGION: 'r',
      VERTEX_MODEL: 'gemini-2.5-flash', VERTEX_LOCATION: 'us-central1',
      LIFECYCLE_MANAGER_URL: 'https://lifecycle.test', ACTIVITY_TOPIC: 'agent-activity-stream',
      TAXONOMY_VERSION: 'v1', AGENT_MAX_LIFETIME_SECONDS: '86400',
    };
    expect(() => loadConfig(complete)).not.toThrow();
    expect(() => loadConfig({ ...complete, ISSUER: undefined })).toThrow(/ISSUER/);
    expect(() => loadConfig({ ...complete, VERTEX_MODEL: undefined })).toThrow(/VERTEX_MODEL/);
  });
});
