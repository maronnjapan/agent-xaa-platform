import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ENV_KEYS } from '@xaa/contracts';
import { jwkThumbprint } from '@xaa/crypto';
import { createAgentClientCredential } from '../src/agent/identity.js';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type ProvisionerHarness, type TokenIssuer } from './helpers.js';

/**
 * docs 05 §4 / RULE-22 / RULE-38. The key an agent authenticates with exists in this
 * process's memory and in one Job Execution's environment. Nowhere else.
 *
 * Not in Firestore, not in Secret Manager, not in the HTTP response, not in a log
 * line. The reason is what the key is for: holding it is being that agent, so any
 * store that keeps it becomes a place from which an agent can be impersonated for as
 * long as the copy survives — which, for a store, is longer than the agent.
 *
 * Only the public half and its RFC 7638 thumbprint are recorded, which is all the
 * Agent OP needs to check a client assertion.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

function keysOf(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { for (const item of value) keysOf(item, found); return found; }
  for (const [key, item] of Object.entries(value)) { found.push(key); keysOf(item, found); }
  return found;
}

async function provisioned(target: ProvisionerHarness): Promise<{ agentId: string; body: Record<string, unknown> }> {
  const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
  const response = await issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
  expect(response.status).toBe(201);
  const body = await response.json() as Record<string, unknown>;
  return { agentId: body.agent_id as string, body };
}

describe('the Agent Client Credential', () => {
  it('is an ES256 pair whose public half carries the agent id as its kid', async () => {
    const credential = await createAgentClientCredential('agent-abcdefghijklmnopqrstuvwxyz');
    expect(credential.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'agent-abcdefghijklmnopqrstuvwxyz' });
    expect(credential.thumbprint).toBe(await jwkThumbprint(credential.publicJwk));
    expect(Object.keys(credential.publicJwk)).not.toContain('d');
    // The private half is a string on the return value and is never put anywhere else.
    expect(JSON.parse(credential.privateJwkJson)).toHaveProperty('d');
  });

  it('leaves no d anywhere in the document Firestore holds', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const { agentId } = await provisioned(target);

    const registration = await target.documents.get<Record<string, unknown>>('agents', `${agentId}__meta`);
    expect(keysOf(registration)).not.toContain('d');
    // And nowhere else this run wrote either: a key that leaked into the manifest copy
    // or the ledger would be just as durable as one in the registration.
    for (const collection of ['agents', 'provisioning_transactions', 'dedicated_resources', 'provisioning_codes']) {
      const rows = await target.documents.listAll(collection);
      expect(keysOf(rows.map((row) => row.data))).not.toContain('d');
    }
  });

  it('hands the private half to the execution and to nothing else', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const { agentId } = await provisioned(target);

    const env = Object.fromEntries(target.jobRuns[0]!.env.map((entry) => [entry.name, entry.value]));
    expect(Object.keys(env).sort()).toEqual([...RUNTIME_ENV_KEYS].sort());
    const privateJwk = JSON.parse(env.AGENT_CLIENT_PRIVATE_JWK!) as { d?: string; kty: string };
    expect(privateJwk.d).toBeTruthy();
    expect(privateJwk.kty).toBe('EC');

    const registration = await target.documents.get<{ client_auth: { jwk_thumbprint: string } }>('agents', `${agentId}__meta`);
    expect(registration!.client_auth.jwk_thumbprint).toBe(await jwkThumbprint({
      kty: 'EC', crv: 'P-256',
      x: (JSON.parse(env.AGENT_CLIENT_PRIVATE_JWK!) as { x: string }).x,
      y: (JSON.parse(env.AGENT_CLIENT_PRIVATE_JWK!) as { y: string }).y,
    }));
  });

  it('says nothing about the key in what it answers, and nothing in what it logs', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
    const { body } = await provisioned(target);
    expect(Object.keys(body).sort()).toEqual([
      'agent_id', 'allowed_tools', 'expires_at', 'isolation_level', 'status', 'transaction_id',
    ]);
    expect(keysOf(body)).not.toContain('d');
    const secret = JSON.parse(
      Object.fromEntries(target.jobRuns[0]!.env.map((entry) => [entry.name, entry.value])).AGENT_CLIENT_PRIVATE_JWK!,
    ) as { d: string };
    expect(JSON.stringify(body)).not.toContain(secret.d);
    expect(target.logs.join('\n')).not.toContain(secret.d);
  });
});
