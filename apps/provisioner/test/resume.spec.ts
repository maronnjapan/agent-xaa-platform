import { beforeAll, describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint, type Es256KeyPair } from '@xaa/crypto';
import { toRfc3339Seconds } from '../src/agent/expiry.js';
import { createCompletionCodes } from '../src/transaction/one-time-code.js';
import {
  createProvisionerHarness, PROVISIONER_BASE, HUMAN_IDP_ISSUER, seedDecision, type ProvisionerHarness,
} from './helpers.js';

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

async function accessToken(subject = 'testuser'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'at+jwt', kid: 'idp-testkey' };
  const payload = {
    iss: HUMAN_IDP_ISSUER, sub: subject, aud: ['agent-provisioner', `${HUMAN_IDP_ISSUER}/userinfo`],
    exp: now + 300, iat: now, nbf: now, jti: `at-${Math.random().toString(36).slice(2)}`,
    scope: 'openid agent:provision', client_id: 'automation-app',
    cnf: { jkt: await jwkThumbprint(dpopKeyPair.publicJwk) },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

async function resume(target: ProvisionerHarness, transactionId: string, code: string, subject = 'testuser'): Promise<Response> {
  const token = await accessToken(subject);
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

/**
 * A provisioning parked exactly where a consent screen parks one: the transaction
 * carries the work, the constraints and the expiry that were fixed before the person
 * was sent away, because those are what the resume has to finish the agent with.
 */
async function pausedTransaction(target: ProvisionerHarness): Promise<string> {
  // The resume re-checks the capabilities against what the person actually holds, so
  // the permissions have to exist even though the decision itself is behind us.
  await seedDecision(target, { capabilities: ['document.read'] });
  const transaction = await target.deps.transactions.create({
    human_subject: 'testuser', agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    required_capabilities: ['document.read'], required_connectors: ['internal-docs-api'],
    isolation_level: 'standard', pending_step: 'idp_consent', dedicated_short_id: null,
    // To the second, as the Provisioner writes it: the same string reaches the
    // registration, the IdP connection and the job environment.
    task_id: 'wd-1', constraints: {}, agent_expires_at: toRfc3339Seconds(Date.now() + 3_600_000),
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

  /**
   * The point of the whole round trip. `RESUMABLE` is a state the transaction passes
   * through, not an outcome: a resume that stopped there left the person back on the
   * dashboard with the consent they had just given and no agent to show for it, and
   * the transaction sat untouched until the Lifecycle sweep abandoned it.
   */
  it('finishes the provisioning the consent interrupted', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });

    const response = await resume(target, transactionId, code);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: 'PROVISIONED', agent_id: 'agent-abcdefghijklmnopqrstuvwxyz', transaction_id: transactionId,
    });

    // Registered, running, and the transaction closed behind it.
    const registration = await target.documents.get<{ status: string; expires_at: string }>(
      'agents', 'agent-abcdefghijklmnopqrstuvwxyz__meta',
    );
    expect(registration!.status).toBe('ACTIVE');
    expect(target.jobRuns).toHaveLength(1);
    expect((await target.deps.transactions.find(transactionId))!.status).toBe('COMPLETED');
  });

  /**
   * The expiry was fixed before the person was sent to the consent screen, and the
   * time they spent there is theirs, not the agent's. Recomputing it on the way back
   * would hand every consented agent however long the round trip took.
   */
  it('keeps the expiry the pause was entered with', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    const paused = await target.deps.transactions.find(transactionId);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });

    const response = await resume(target, transactionId, code);
    expect(await response.json()).toMatchObject({ expires_at: paused!.agent_expires_at });
  });

  /**
   * The connection was created by the request that paused, and that request is over.
   * If this half cannot finish, nothing else is left holding the undo: a refresh token
   * for an agent that will never exist would otherwise sit there until it expired
   * (RULE-51).
   */
  it('revokes the connection when the second half cannot finish', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });
    // The registration is the first lasting write of the resumed half; a name already
    // taken is what a retry of an agent that got that far runs into.
    await target.documents.set('agents', 'agent-abcdefghijklmnopqrstuvwxyz__meta', {
      agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
    });

    const response = await resume(target, transactionId, code);

    expect(response.status).toBe(500);
    expect(target.revokedConnections).toEqual(['idpconn-agent-abcdefghijklmnopqrstuvwxyz']);
    expect(target.jobRuns).toHaveLength(0);
    expect((await target.deps.transactions.find(transactionId))!.status).toBe('FAILED');
  });

  /**
   * The subject is checked before the code is consumed. A caller who is not the person
   * the code was minted for must not be able to burn it by trying: the code is
   * single-use, so a refusal that spent it would let anyone deny the rightful owner
   * their own resume by presenting the code first.
   */
  it('refuses another person and leaves the code unspent', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });

    const refused = await resume(target, transactionId, code, 'someone-else');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'code_owner_mismatch' });

    const stored = await target.documents.listAll<{ used_at: string | null }>('provisioning_codes');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.data.used_at).toBe(null);
    // And the rightful owner can still use it.
    expect((await resume(target, transactionId, code)).status).toBe(201);
    expect((await target.documents.listAll<{ used_at: string | null }>('provisioning_codes'))[0]!.data.used_at)
      .not.toBe(null);
  });

  /**
   * A transaction from before this route could finish one carries none of what the
   * second half needs. It is refused rather than provisioned on defaults, and the
   * refusal comes before the code is consumed: burning it would cost the person the
   * consent they just gave for a resume that was never going to work.
   */
  it('refuses a transaction that carries none of the resume inputs, and keeps the code', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    await target.documents.update('provisioning_transactions', transactionId, {
      task_id: '', agent_expires_at: '',
    });
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });

    const response = await resume(target, transactionId, code);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'transaction_not_resumable' });
    expect((await target.documents.listAll<{ used_at: string | null }>('provisioning_codes'))[0]!.data.used_at)
      .toBe(null);
    expect(await target.documents.listAll('agents')).toEqual([]);
  });

  it('answers a browser landing on the resume url with 405 and Allow: POST', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk });
    const transactionId = await pausedTransaction(target);
    // Registered on purpose rather than left to fall through to a 404: the person is
    // arriving from a consent screen, and a 404 would read as "your consent was lost".
    const response = await target.fetch(`/provisioning/${transactionId}/resume`, { method: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('refuses to resume a transaction that already ended', async () => {
    const target = await createProvisionerHarness({ idpPublicJwk: publicJwk, verifyStatus: 'READY' });
    const transactionId = await pausedTransaction(target);
    const codes = createCompletionCodes(target.documents, () => Date.now());
    const code = await codes.issue({ transaction_id: transactionId, human_subject: 'testuser', issuer_kind: 'idp' });
    await target.deps.transactions.advance(transactionId, 'FAILED', { pending_step: 'idp_consent' });

    const response = await resume(target, transactionId, code);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'transaction_not_resumable' });
  });
});
