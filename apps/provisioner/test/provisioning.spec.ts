import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { RUNTIME_ENV_KEYS } from '@xaa/contracts';
import { createProvisionerHarness, seedDecision, recordingAdmin, PROVISIONER_BASE, HUMAN_IDP_ISSUER, type ProvisionerHarness } from './helpers.js';

/**
 * A DPoP-bound Access Token for the Provisioner, signed with an RSA key so the
 * verification path matches Human IdP's.
 */
let signingKey: CryptoKey;
let publicJwk: JsonWebKey;
let dpopKeyPair: Es256KeyPair;

beforeAll(async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  signingKey = pair.privateKey;
  publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  dpopKeyPair = await generateEs256KeyPair();
});

async function accessToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'at+jwt', kid: 'idp-testkey' };
  const payload = {
    iss: HUMAN_IDP_ISSUER, sub: 'testuser', aud: ['agent-provisioner', `${HUMAN_IDP_ISSUER}/userinfo`],
    exp: now + 300, iat: now, nbf: now, jti: `at-${Math.random().toString(36).slice(2)}`,
    scope: 'openid agent:provision', client_id: 'automation-app',
    cnf: { jkt: await jwkThumbprint(dpopKeyPair.publicJwk) }, ...overrides,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function harness(options: Parameters<typeof createProvisionerHarness>[0] = {}): Promise<ProvisionerHarness> {
  return createProvisionerHarness({ ...options, idpPublicJwk: publicJwk });
}

async function provision(target: ProvisionerHarness, body: unknown, options: { omitProof?: boolean; token?: string } = {}) {
  const token = options.token ?? await accessToken();
  const headers: Record<string, string> = { 'content-type': 'application/json', Authorization: `DPoP ${token}` };
  if (!options.omitProof) {
    headers.DPoP = await createDpopProof({
      method: 'POST', url: `${PROVISIONER_BASE}/provisioning`, keyPair: dpopKeyPair, accessToken: token,
    });
  }
  return target.fetch('/provisioning', { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /provisioning, STANDARD', () => {
  it('provisions an agent and starts exactly one job', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read', 'document.write'] });
    const response = await provision(target, { decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 8 });
    expect(response.status).toBe(201);
    const body = await response.json() as { agent_id: string; allowed_tools: string[]; isolation_level: string };
    expect(body.agent_id).toMatch(/^agent-[0-9a-z]{26}$/);
    expect(body.isolation_level).toBe('standard');
    expect(body.allowed_tools).toEqual([
      'internal.document.create', 'internal.document.get', 'internal.document.list', 'internal.document.update',
    ]);
    expect(target.jobRuns).toHaveLength(1);
  });

  it('creates no GCP resource at all', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    await provision(target, { decision_id: decisionId, task_id: 'task-1', requested_lifetime_hours: 8 });
    expect(target.admin.calls).toEqual([]);
  });

  it('overrides exactly the ten runtime keys, with the manifest digest added', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    await provision(target, { decision_id: decisionId, task_id: 'task-7', requested_lifetime_hours: 8 });
    const names = target.jobRuns[0]!.env.map((entry) => entry.name).sort();
    expect(names).toEqual([...RUNTIME_ENV_KEYS].sort());
    const values = Object.fromEntries(target.jobRuns[0]!.env.map((entry) => [entry.name, entry.value]));
    expect(values.TASK_ID).toBe('task-7');
    expect(values.ISOLATION_LEVEL).toBe('standard');
    expect(values.AGENT_OP_BASE_URL).toBe('https://shared-agent-op.test');
    expect(JSON.parse(values.TOOL_MANIFEST!)).toMatchObject({ agent_id: values.AGENT_ID });
  });

  it('writes a registration carrying no API detail', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const body = await (await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 })).json() as { agent_id: string };
    const registration = await target.documents.get<Record<string, unknown>>('agents', `${body.agent_id}__meta`);
    expect(Object.keys(registration!).sort()).toEqual([
      'agent_id', 'allowed_audiences', 'client_auth', 'created_at', 'dedicated_op', 'expires_at',
      'human_subject', 'idp_connection_id', 'isolation_level', 'job_execution_name', 'resources', 'scopes',
      'status', 'trusted_resource_as',
    ]);
    for (const forbidden of ['api_base_url', 'api_method', 'api_path', 'tool_id', 'issuer', 'subject']) {
      expect(Object.keys(registration!)).not.toContain(forbidden);
    }
    expect(registration!.status).toBe('ACTIVE');
  });

  it('never records the private key', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const body = await (await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 })).json() as { agent_id: string };
    const registration = await target.documents.get<Record<string, unknown>>('agents', `${body.agent_id}__meta`);
    expect(JSON.stringify(registration)).not.toContain('"d"');
  });

  it('gives two agents different keys and different registrations', async () => {
    const target = await harness();
    const first = await seedDecision(target, { capabilities: ['document.read'] });
    const second = await seedDecision(target, { capabilities: ['document.read'] });
    const one = await (await provision(target, { decision_id: first, task_id: 'a', requested_lifetime_hours: 8 })).json() as { agent_id: string };
    const two = await (await provision(target, { decision_id: second, task_id: 'b', requested_lifetime_hours: 8 })).json() as { agent_id: string };
    expect(one.agent_id).not.toBe(two.agent_id);
    const thumbprints = await Promise.all([one, two].map(async (agent) => {
      const registration = await target.documents.get<{ client_auth: { jwk_thumbprint: string } }>('agents', `${agent.agent_id}__meta`);
      return registration!.client_auth.jwk_thumbprint;
    }));
    expect(new Set(thumbprints).size).toBe(2);
  });

  it('caps the lifetime at the platform maximum', async () => {
    const target = await harness({ config: { agentMaxLifetimeSeconds: 3600 } });
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 1 });
    const body = await response.json() as { expires_at: string };
    expect(Date.parse(body.expires_at) - Date.now()).toBeLessThanOrEqual(3_600_000);
  });
});

describe('POST /provisioning refuses before it writes', () => {
  async function writeCount(target: ProvisionerHarness): Promise<number> {
    return (await target.documents.listAll('provisioning_transactions')).length;
  }

  it('refuses a request with no proof and writes nothing', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 }, { omitProof: true });
    expect(response.status).toBe(401);
    expect(await writeCount(target)).toBe(0);
  });

  it('refuses a body naming permissions and writes nothing', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await provision(target, {
      decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8, effective_capabilities: ['finance.payment.approve'],
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('authorization_field_not_allowed');
    expect(await writeCount(target)).toBe(0);
  });

  it('refuses another human\'s decision', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'], humanSubject: 'someone-else' });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    expect(response.status).toBe(403);
    expect(await writeCount(target)).toBe(0);
  });

  it('refuses an unknown decision', async () => {
    const target = await harness();
    const response = await provision(target, { decision_id: `dec_${crypto.randomUUID()}`, task_id: 't', requested_lifetime_hours: 8 });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('decision_mismatch');
    expect(await writeCount(target)).toBe(0);
  });

  it('refuses a capability the human no longer holds', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'], grantHumanPermissions: false });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('capability_not_subset_of_human_permission');
    expect(await writeCount(target)).toBe(0);
  });

  it('refuses a capability with no tool', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['mail.message.send'] });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'no_tool_for_capability', capability_id: 'mail.message.send' });
    expect(await writeCount(target)).toBe(0);
  });

  it('pauses with a consent url that is not its own host', async () => {
    const target = await harness({ idpConnectionStatus: 'CONSENT_REQUIRED' });
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; consent_url: string; connector_id?: string };
    expect(body.status).toBe('IDP_CONSENT_REQUIRED');
    expect(new URL(body.consent_url).host).not.toBe(new URL(PROVISIONER_BASE).host);
    expect(body).not.toHaveProperty('connector_id');
    expect(target.jobRuns).toHaveLength(0);
  });
});

describe('POST /provisioning, FULL_ISOLATION', () => {
  it('creates the six dedicated resources in order and records each one', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, {
      capabilities: ['finance.payment.read', 'finance.payment.approve'], isolationLevel: 'full_isolation',
    });
    const response = await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    expect(response.status).toBe(201);
    const body = await response.json() as { agent_id: string };

    expect(target.admin.calls.map((call) => call.method)).toEqual([
      'createServiceAccount', 'createServiceAccount', 'createCryptoKey', 'createCryptoKey',
      ...Array.from({ length: 9 }, () => 'bindRole'),
      'createService', 'createJob',
    ]);
    const ledger = await target.documents.get<{ created: Array<{ kind: string; name: string }>; status: string }>('dedicated_resources', body.agent_id);
    expect(ledger!.status).toBe('READY');
    expect(new Set(ledger!.created.map((entry) => entry.kind))).toEqual(
      new Set(['service_account', 'crypto_key', 'iam_binding', 'cloud_run_service', 'cloud_run_job']),
    );
  });

  it('points the agent at its own OP, not the shared one', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation' });
    await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 });
    const values = Object.fromEntries(target.jobRuns[0]!.env.map((entry) => [entry.name, entry.value]));
    expect(values.AGENT_OP_BASE_URL).toMatch(/^https:\/\/dedicated-op-/);
    expect(values.ISOLATION_LEVEL).toBe('full_isolation');
  });

  it('answers 503 once the capacity is used up, writing nothing', async () => {
    const target = await harness({ config: { maxFullIsolationAgents: 1 } });
    const first = await seedDecision(target, { capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation' });
    expect((await provision(target, { decision_id: first, task_id: 'a', requested_lifetime_hours: 8 })).status).toBe(201);

    const before = (await target.documents.listAll('provisioning_transactions')).length;
    const second = await seedDecision(target, { capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation' });
    const response = await provision(target, { decision_id: second, task_id: 'b', requested_lifetime_hours: 8 });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toEqual({ error: 'full_isolation_capacity_reached', active: 1, capacity: 1 });
    expect((await target.documents.listAll('provisioning_transactions')).length).toBe(before);
  });

  it('never downgrades to standard when the capacity is full', async () => {
    const target = await harness({ config: { maxFullIsolationAgents: 1 } });
    const first = await seedDecision(target, { capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation' });
    await provision(target, { decision_id: first, task_id: 'a', requested_lifetime_hours: 8 });
    const second = await seedDecision(target, { capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation' });
    await provision(target, { decision_id: second, task_id: 'b', requested_lifetime_hours: 8 });
    expect(target.jobRuns).toHaveLength(1);
  });

  it('keeps the ledger accurate when creation fails partway', async () => {
    const target = await harness({ admin: recordingAdmin({ failAt: 'createCryptoKey' }) });
    const decisionId = await seedDecision(target, { capabilities: ['finance.payment.approve'], isolationLevel: 'full_isolation' });
    await provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_hours: 8 }).catch(() => undefined);
    const ledgers = await target.documents.listAll<{ created: unknown[] }>('dedicated_resources');
    expect(ledgers[0]!.data.created).toHaveLength(2);
  });
});
