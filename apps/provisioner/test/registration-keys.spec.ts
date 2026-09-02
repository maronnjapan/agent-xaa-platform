import { beforeAll, describe, expect, it } from 'vitest';
import { compile, SchemaValidationError } from '@xaa/contracts';
import { agentRegistrationSchema, type ProvisionedRegistration } from '../src/agent/registration.js';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type TokenIssuer } from './helpers.js';

/**
 * RULE-16 / RULE-20 / RULE-46. What the Agent OP is allowed to know about an agent.
 *
 * The Agent OP decides whether a request is inside an agent's static XAA configuration.
 * To do that it needs three sets — audiences, resources, scopes — and nothing about the
 * APIs behind them: an OP that knew a tool's base URL could be asked to reason about
 * endpoints, and the tool catalogue would then have two homes that could disagree.
 *
 * `issuer` and `subject` are absent for the same reason from the other side: the agent
 * is not an issuer of anything, and its subject is the person's, carried in `act`.
 *
 * The list is a snapshot rather than a spot check. A new key is a new thing the OP
 * knows, and it should have to be argued for here before it is written.
 */
const REGISTRATION_KEYS = [
  'agent_id', 'human_subject', 'client_auth', 'idp_connection_id',
  'allowed_audiences', 'resources', 'scopes', 'trusted_resource_as',
  'created_at', 'expires_at', 'status', 'dedicated_op', 'isolation_level', 'job_execution_name',
];

const assertRegistration: (value: unknown) => asserts value is ProvisionedRegistration =
  compile<ProvisionedRegistration>(agentRegistrationSchema);

function valid(): Record<string, unknown> {
  return {
    agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    human_subject: 'testuser',
    client_auth: {
      method: 'client_assertion_jwt',
      jwk_thumbprint: 'tp',
      public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k', alg: 'ES256', use: 'sig' },
    },
    idp_connection_id: 'idpconn-agent-abcdefghijklmnopqrstuvwxyz',
    allowed_audiences: ['https://resource-docs-as.test'],
    resources: ['https://resource-docs-api.test'],
    scopes: ['docs.read'],
    trusted_resource_as: ['https://resource-docs-as.test'],
    created_at: '2026-03-01T00:00:00.000Z',
    expires_at: '2026-03-01T08:00:00.000Z',
    status: 'PROVISIONING',
    dedicated_op: null,
    isolation_level: 'standard',
    job_execution_name: null,
  };
}

let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

describe('the keys an agent registration carries', () => {
  it('matches the snapshot, in the document Firestore actually holds', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    const { agent_id: agentId } = await response.json() as { agent_id: string };

    const stored = await target.documents.get<Record<string, unknown>>('agents', `${agentId}__meta`);
    expect(Object.keys(stored!).sort()).toEqual([...REGISTRATION_KEYS].sort());
    expect(Object.keys(agentRegistrationSchema.properties).sort()).toEqual([...REGISTRATION_KEYS].sort());
  });

  it('has no issuer and no subject key', () => {
    expect(REGISTRATION_KEYS).not.toContain('issuer');
    expect(REGISTRATION_KEYS).not.toContain('subject');
    expect(Object.keys(agentRegistrationSchema.properties)).not.toContain('issuer');
    expect(Object.keys(agentRegistrationSchema.properties)).not.toContain('subject');
    expect(() => assertRegistration({ ...valid(), issuer: 'https://human-idp.test' })).toThrow(SchemaValidationError);
    expect(() => assertRegistration({ ...valid(), subject: 'testuser' })).toThrow(SchemaValidationError);
  });

  it('refuses a JWK carrying the private half', () => {
    const registration = valid();
    const clientAuth = registration.client_auth as { public_jwk: Record<string, unknown> };
    // `d` is the private scalar. A registration is world-readable inside the platform,
    // so one that accepted `d` would publish the key the agent authenticates with.
    expect(() => assertRegistration({
      ...registration,
      client_auth: { ...clientAuth, public_jwk: { ...clientAuth.public_jwk, d: 'private-scalar' } },
    })).toThrow(SchemaValidationError);
  });

  it('refuses the API detail a tool would carry', () => {
    for (const field of ['api_base_url', 'api_method', 'api_path', 'tool_id', 'description']) {
      expect(() => assertRegistration({ ...valid(), [field]: 'x' })).toThrow(SchemaValidationError);
    }
  });

  it('accepts the shape the Provisioner writes', () => {
    expect(() => assertRegistration(valid())).not.toThrow();
    expect(agentRegistrationSchema.additionalProperties).toBe(false);
    expect(agentRegistrationSchema.properties.client_auth.additionalProperties).toBe(false);
    expect(agentRegistrationSchema.properties.client_auth.properties.public_jwk.additionalProperties).toBe(false);
  });
});
