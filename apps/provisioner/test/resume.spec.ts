import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { createCompletionCodes } from '../src/transaction/one-time-code.js';
import { createProvisionerHarness, PROVISIONER_BASE, HUMAN_IDP_ISSUER, type ProvisionerHarness } from './helpers.js';

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

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'at+jwt', kid: 'idp-testkey' };
  const payload = {
    iss: HUMAN_IDP_ISSUER, sub: 'testuser', aud: ['agent-provisioner', `${HUMAN_IDP_ISSUER}/userinfo`],
    exp: now + 300, iat: now, nbf: now, jti: `at-${Math.random().toString(36).slice(2)}`,
    scope: 'openid agent:provision', client_id: 'automation-app',
    cnf: { jkt: await jwkThumbprint(dpopKeyPair.publicJwk) },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function resume(target: ProvisionerHarness, transactionId: string, code: string): Promise<Response> {
  const token = await accessToken();
  const path = `/provisioning/${transactionId}/resume`;
  return target.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `DPoP ${token}`,
      DPoP: await createDpopProof({ method: 'POST', url: `${PROVISIONER_BASE}${path}`, keyPair: dpopKeyPair, accessToken: token }),
    },
    body: JSON.stringify({ one_time_code: code }),
  });
}

async function pausedTransaction(target: ProvisionerHarness): Promise<string> {
  const transaction = await target.deps.transactions.create({
    human_subject: 'testuser', agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    required_capabilities: ['document.read'], required_connectors: ['internal-docs-api'],
    isolation_level: 'standard', pending_step: 'idp_consent', dedicated_short_id: null,
  });
  await target.deps.transactions.advance(transaction.transaction_id, 'WAITING_IDP_CONSENT', { pending_step: 'idp_consent' });
  return transaction.transaction_id;
}

describe('resuming after a consent', () => {
  it('asks the issuer named on the code, and refuses one this service cannot ask about', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk });
    const transactionId = await pausedTransaction(target);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    // A connector's consent is the Bridge's to confirm. Verifying it against the Agent
    // OP's IdP connection would answer READY about an entirely different consent.
    const code = await codes.issue({
      transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'stub-saas-calendar',
    });

    const response = await resume(target, transactionId, code);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'connection_not_ready' });
    const stored = await target.deps.transactions.find(transactionId);
    expect(stored!.status).toBe('WAITING_IDP_CONSENT');
  });

  it('accepts a code the Agent OP issued', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });

    const response = await resume(target, transactionId, code);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'RESUMABLE', pending_step: 'verify_idp_connection' });
  });
});
