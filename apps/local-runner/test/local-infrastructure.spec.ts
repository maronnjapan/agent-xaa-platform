import { describe, expect, it } from 'vitest';
import { ForbiddenRuntimeName } from '@xaa/contracts';
import { createLocalRunPlatform } from '../src/local/cloud-run.js';
import { createLocalJwks, publishable } from '../src/local/jwks.js';
import { createBridgeKms, createLocalEnvelope, createLocalKms } from '../src/local/kms.js';
import { createLocalPubSub } from '../src/local/pubsub.js';
import { createLocalServiceIdentity, serviceAccounts } from '../src/local/service-identity.js';
import { createTopology } from '../src/topology.js';

const KEY = 'projects/xaa-local/locations/asia-northeast1/keyRings/idp-connection-encryption/cryptoKeys/idp-connection';

/**
 * The properties the applications above these stand-ins actually depend on. Each one is
 * a property of the Google product being stood in for, so a test that holds it here is
 * the local platform's claim that the behaviour is the same.
 */
describe('the local Cloud KMS', () => {
  it('binds a ciphertext to the additional authenticated data it was made with', async () => {
    const kms = createLocalKms();
    const encrypted = await kms.encrypt({
      name: KEY, plaintext: Buffer.from('rt-1', 'utf8'), additionalAuthenticatedData: Buffer.from('agent-a', 'utf8'),
    });
    const ciphertext = Buffer.from(encrypted[0].ciphertext as Uint8Array);

    // REQ-05-045: the same row copied into another agent's record does not decrypt.
    await expect(kms.decrypt({
      name: KEY, ciphertext, additionalAuthenticatedData: Buffer.from('agent-b', 'utf8'),
    })).rejects.toThrow();

    const back = await kms.decrypt({
      name: KEY, ciphertext, additionalAuthenticatedData: Buffer.from('agent-a', 'utf8'),
    });
    expect(Buffer.from(back[0].plaintext as Uint8Array).toString('utf8')).toBe('rt-1');
  });

  it('gives each key resource name its own key material', async () => {
    const kms = createLocalKms();
    const encrypted = await kms.encrypt({ name: KEY, plaintext: Buffer.from('secret', 'utf8') });
    await expect(kms.decrypt({
      name: `${KEY}-other`, ciphertext: Buffer.from(encrypted[0].ciphertext as Uint8Array),
    })).rejects.toThrow();
  });

  it('round-trips through both shapes the applications ask for', async () => {
    const kms = createLocalKms();
    const envelope = createLocalEnvelope(kms, KEY);
    expect(await envelope.decrypt(await envelope.encrypt('sso-key'))).toBe('sso-key');

    const bridge = createBridgeKms(kms);
    const bytes = new TextEncoder().encode('connector');
    expect(new TextDecoder().decode(await bridge.decrypt(KEY, await bridge.encrypt(KEY, bytes)))).toBe('connector');
  });
});

describe('the local service identity', () => {
  it('resolves a token to the account it was minted for', async () => {
    const identity = await createLocalServiceIdentity();
    const token = await identity.mint('http://127.0.0.1:8085', 'sa-authorization@xaa-local.iam.gserviceaccount.com');
    await expect(identity.verify(token, 'http://127.0.0.1:8085'))
      .resolves.toBe('sa-authorization@xaa-local.iam.gserviceaccount.com');
  });

  /**
   * The check that makes a Cloud Run token worth anything: one minted for one service
   * does not open another. Without it every internal allow-list in the platform would
   * be checking a name anybody could claim.
   */
  it('refuses a token minted for a different destination, and a forged one', async () => {
    const identity = await createLocalServiceIdentity();
    const other = await createLocalServiceIdentity();
    const token = await identity.mint('http://127.0.0.1:8084', 'sa-lifecycle@xaa-local.iam.gserviceaccount.com');
    await expect(identity.verify(token, 'http://127.0.0.1:8085')).resolves.toBeNull();
    await expect(other.verify(token, 'http://127.0.0.1:8084')).resolves.toBeNull();
    await expect(identity.verify('not-a-token', 'http://127.0.0.1:8084')).resolves.toBeNull();
  });

  it('names service accounts the way Terraform names them', () => {
    expect(serviceAccounts('xaa-local').provisioner).toBe('sa-provisioner@xaa-local.iam.gserviceaccount.com');
  });
});

describe('the local Pub/Sub', () => {
  it('delivers a published message to a pull subscriber', async () => {
    const pubsub = createLocalPubSub();
    const seen: unknown[] = [];
    pubsub.pullSubscription('security-logs').on('message', (message) => {
      seen.push(JSON.parse(message.data.toString('utf8')));
      message.ack();
    });
    await pubsub.topic('security-logs').publishMessage({ json: { event: 'token_exchange' } });
    await pubsub.drain();
    expect(seen).toEqual([{ event: 'token_exchange' }]);
  });

  it('leaves a topic nobody subscribes to without a publisher noticing', async () => {
    const pubsub = createLocalPubSub();
    await expect(pubsub.publish('human-identity-disabled', { agent_id: 'a' })).resolves.toBeUndefined();
  });
});

describe('the local JWK Set', () => {
  it('never publishes a private half', () => {
    const jwks = createLocalJwks();
    jwks.publish(publishable(
      { kty: 'RSA', n: 'nnn', e: 'AQAB', d: 'private', p: 'p', key_ops: ['sign'], ext: true } as JsonWebKey,
      'idp-abcd1234', 'RS256',
    ));
    const [key] = jwks.document().keys;
    expect(key).toEqual({ kty: 'RSA', n: 'nnn', e: 'AQAB', kid: 'idp-abcd1234', alg: 'RS256', use: 'sig' });
  });

  it('takes a key away when its owner is destroyed', () => {
    const jwks = createLocalJwks();
    jwks.publish(publishable({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey, 'idjag-abc123456789-1', 'ES256'));
    jwks.remove('idjag-abc123456789-1');
    expect(jwks.document().keys).toEqual([]);
  });
});

describe('the local Cloud Run', () => {
  const platform = () => createLocalRunPlatform({
    projectId: 'xaa-local',
    region: 'asia-northeast1',
    jwks: createLocalJwks(),
    startService: async (input) => ({ uri: `http://127.0.0.1:8200/${input.name}`, async stop() {} }),
    startExecution: () => ({ finished: Promise.resolve(0), cancel: () => {} }),
  });

  /**
   * DEC-IAC-08. The boundary between what Terraform owns and what runtime code may
   * touch is drawn by name, and it has to hold here as it does on GCP: a request
   * naming a deployed service is refused before anything happens.
   */
  it('refuses to create or delete anything outside the runtime name space', async () => {
    const run = platform();
    await expect(run.admin.createService({ name: 'human-idp', serviceAccount: 'sa', env: {}, labels: {} }))
      .rejects.toBeInstanceOf(ForbiddenRuntimeName);
    await expect(run.admin.createServiceAccount({ accountId: 'sa-automation-app', description: '' }))
      .rejects.toBeInstanceOf(ForbiddenRuntimeName);
    await expect(run.cleanup.cloudRun.deleteService('projects/xaa-local/locations/asia-northeast1/services/authorization'))
      .rejects.toBeInstanceOf(ForbiddenRuntimeName);
  });

  it('merges a Job definition with the Execution overrides, as Cloud Run does', async () => {
    const seen: Array<Record<string, string>> = [];
    const run = createLocalRunPlatform({
      projectId: 'xaa-local', region: 'asia-northeast1', jwks: createLocalJwks(),
      startService: async () => ({ uri: 'http://127.0.0.1:8200', async stop() {} }),
      startExecution: (input) => { seen.push(input.env); return { finished: Promise.resolve(0), cancel: () => {} }; },
    });
    const jobName = run.defineJob('agent-runtime-standard', { STORE_MODE: 'emulator', ISOLATION_LEVEL: 'standard' });
    const started = await run.jobs.runJob({ jobName, env: [{ name: 'AGENT_ID', value: 'agent-a' }] });
    expect(started.executionName).toMatch(/\/jobs\/agent-runtime-standard\/executions\//);
    expect(seen[0]).toEqual({ STORE_MODE: 'emulator', ISOLATION_LEVEL: 'standard', AGENT_ID: 'agent-a' });
  });

  it('undoes what the ledger recorded, and answers not_found for what it does not hold', async () => {
    const run = platform();
    const account = await run.admin.createServiceAccount({ accountId: 'sa-agent-abc123456789', description: '' });
    const binding = await run.admin.bindRole({ resource: 'projects/xaa-local', member: account.member, role: 'roles/datastore.user' });
    const service = await run.admin.createService({ name: 'dedicated-op-abc123456789', serviceAccount: account.email, env: {}, labels: {} });

    await expect(run.cleanup.iam.removeBinding(binding)).resolves.toBe('removed');
    await expect(run.cleanup.iam.removeBinding(binding)).resolves.toBe('not_found');
    await expect(run.cleanup.cloudRun.deleteService(service.name)).resolves.toBe('deleted');
    await expect(run.cleanup.cloudRun.deleteService(service.name)).resolves.toBe('not_found');
    await expect(run.cleanup.iam.deleteServiceAccount(account.name)).resolves.toBe('deleted');
  });

  it('cancels an Execution that is still running and reports one that has finished', async () => {
    let settle: (code: number) => void = () => {};
    const run = createLocalRunPlatform({
      projectId: 'xaa-local', region: 'asia-northeast1', jwks: createLocalJwks(),
      startService: async () => ({ uri: 'http://127.0.0.1:8200', async stop() {} }),
      startExecution: () => ({
        finished: new Promise<number>((resolve) => { settle = resolve; }),
        cancel: () => { settle(-1); },
      }),
    });
    const jobName = run.defineJob('agent-runtime-standard', {});
    const { executionName } = await run.jobs.runJob({ jobName, env: [] });
    await expect(run.cleanup.cloudRun.cancelExecution(executionName)).resolves.toBe('cancelled');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await expect(run.cleanup.cloudRun.cancelExecution(executionName)).resolves.toBe('already_finished');
    await expect(run.cleanup.cloudRun.cancelExecution(`${jobName}/executions/never`)).resolves.toBe('not_found');
  });
});

describe('the local topology', () => {
  it('names every endpoint the deployed platform names, at loopback addresses', () => {
    const topology = createTopology();
    expect(topology.endpoints.issuer).toBe('http://127.0.0.1:8081');
    expect(topology.endpoints.jwks_url).toBe('http://127.0.0.1:8079/jwks.json');
    // The two placeholders Terraform writes when the Bridge is off, so `resolveEndpoints`
    // reads "no Bridge here" rather than dialling an address.
    expect(topology.endpoints.bridge_internal_url).toBe('https://disabled.invalid');
    expect(topology.endpoints.stub_saas_op_issuer).toBe('https://disabled.invalid');
  });

  it('moves every port together under an offset, so two runs do not collide', () => {
    const topology = createTopology({ portOffset: 700 });
    expect(topology.port['automation-app']).toBe(8780);
    expect(topology.url['automation-app']).toBe('http://127.0.0.1:8780');
    expect(topology.dedicatedPortBase).toBe(8900);
  });

  it('turns the Bridge on by naming it, as `enable_google_bridge` does', () => {
    const topology = createTopology({ bridgeEnabled: true });
    expect(topology.endpoints.bridge_internal_url).toBe(topology.url['google-bridge']);
    expect(topology.endpoints.stub_saas_op_issuer).toBe(topology.url['stub-saas-op']);
  });
});
