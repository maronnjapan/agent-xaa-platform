import { webcrypto } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '@xaa/crypto';
import { callerAuthz } from '../src/middleware/caller-authz.js';
import {
  AGENT_ID, INTERNAL_BASE, SA, createBridgeHarness, seedConnection, seedConnector,
} from '../src/testing/harness.js';

/**
 * Which service account may call which route.
 *
 * Cloud Run's IAM stops at the service, so every route on the internal face would be
 * open to every caller that can invoke the service at all — an agent could create its
 * own binding, the Lifecycle Manager could mint a token. RULE-36 wants the split per
 * route, and that can only live in the app.
 *
 * Every refusal is 403 `forbidden_caller`, whatever went wrong: no header, a forged
 * token, a token minted for another service, the wrong account. A caller learning which
 * of those it was learns which part of the attempt to change.
 */
const body = () => JSON.stringify({
  agent_id: AGENT_ID, connector_id: 'stub-saas',
  connection_id: 'stub-saas:will-be-replaced', human_subject: 'testuser',
  scopes: ['calendar.read'], expires_at: new Date(Date.now() + 3_600_000).toISOString(),
});

async function provisionerReady(): Promise<{ harness: ReturnType<typeof createBridgeHarness>; payload: string }> {
  const harness = createBridgeHarness({ caller: SA.provisioner });
  await seedConnector(harness);
  const connectionId = await seedConnection(harness, { grantedScopes: ['calendar.read'] });
  return { harness, payload: JSON.stringify({ ...JSON.parse(body()) as object, connection_id: connectionId }) };
}

describe('the caller allow list', () => {
  it('runtime SA calls /bindings -> 403', async () => {
    const harness = createBridgeHarness({ caller: SA.runtime });
    await seedConnector(harness);
    await seedConnection(harness);
    const response = await harness.internal('/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' }, body: body(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_caller' });
  });

  it('provisioner SA calls /bindings -> 201', async () => {
    const { harness, payload } = await provisionerReady();
    const response = await harness.internal('/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' }, body: payload,
    });
    expect(response.status).toBe(201);
  });

  it('provisioner SA calls /token -> 403', async () => {
    const harness = createBridgeHarness({ caller: SA.provisioner });
    const response = await harness.internal('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer caller' },
      body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=x',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_caller' });
  });

  it('lifecycle SA calls /bindings/:id/disable -> 204', async () => {
    const harness = createBridgeHarness({ caller: SA.lifecycle });
    const response = await harness.internal(`/bindings/${AGENT_ID}/disable`, {
      method: 'POST', headers: { Authorization: 'Bearer caller' },
    });
    expect(response.status).toBe(204);
  });

  it('refuses /token with no Authorization header at all', async () => {
    const harness = createBridgeHarness({ caller: SA.runtime });
    const response = await harness.internal('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=x',
    });
    // 403 rather than 401: there is nothing a caller could add to a request from an
    // account that is not on the list, so an invitation to authenticate would be a lie.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_caller' });
  });

  it('names no email in the refusal', async () => {
    const harness = createBridgeHarness({ caller: 'sa-someone-else@xaa-test.iam.gserviceaccount.com' });
    const response = await harness.internal('/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' }, body: body(),
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    // The account that was refused is in the log, not in the answer: the answer goes
    // back to whoever sent the request.
    expect(text).not.toContain('email');
    expect(text).not.toContain('sa-someone-else');
    expect(text).toBe(JSON.stringify({ error: 'forbidden_caller' }));
  });

  it('refuses an account whose name merely starts with an allowed one', async () => {
    const harness = createBridgeHarness({ caller: `${SA.provisioner}.attacker.example` });
    const response = await harness.internal('/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' }, body: body(),
    });
    expect(response.status).toBe(403);
  });
});

/**
 * The audience check, against a real signature.
 *
 * `aud` is what stops an ID token minted for another Cloud Run service from being
 * replayed at the Bridge: the two services share one issuer and one key set, so the
 * audience is the only thing that distinguishes them. The token here is signed with a
 * real RSA key and verified through the same code path production uses, with only the
 * certificate endpoint stood in for.
 */
describe('the caller ID token audience', () => {
  async function googleIdToken(options: { audience: string; email: string }): Promise<{
    token: string; certs: typeof fetch;
  }> {
    const pair = await webcrypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
    const issuedAt = Math.floor(Date.now() / 1000);
    const part = (value: unknown) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
    const signingInput = `${part({ alg: 'RS256', kid: 'google-1', typ: 'JWT' })}.${part({
      iss: 'https://accounts.google.com', aud: options.audience, email: options.email,
      email_verified: true, iat: issuedAt, exp: issuedAt + 3600,
    })}`;
    const signature = await webcrypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signingInput),
    );
    return {
      token: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`,
      certs: (async () => Response.json({ keys: [{ ...jwk, kid: 'google-1' }] })) as unknown as typeof fetch,
    };
  }

  const guarded = (fetchImpl: typeof fetch) => new Hono().post(
    '/token',
    callerAuthz(['runtime'], {
      audience: `${INTERNAL_BASE}/`,
      serviceAccounts: { runtime: [SA.runtime], provisioner: [], lifecycle: [] },
      fetchImpl,
    }),
    (context) => context.json({ ok: true }),
  );

  it('accepts a token minted for this service', async () => {
    const { token, certs } = await googleIdToken({ audience: `${INTERNAL_BASE}/`, email: SA.runtime });
    const response = await guarded(certs).fetch(new Request(`${INTERNAL_BASE}/token`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
  });

  it('refuses a token whose aud is another service', async () => {
    const { token, certs } = await googleIdToken({
      audience: 'https://resource-docs-as.test/', email: SA.runtime,
    });
    const response = await guarded(certs).fetch(new Request(`${INTERNAL_BASE}/token`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden_caller' });
  });
});
