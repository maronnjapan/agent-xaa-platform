import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { webcrypto } from 'node:crypto';
import {
  createDpopProof, createLocalEs256Signer, generateEs256KeyPair, InMemoryJtiStore,
  jwkThumbprint, signCompactJws, toPublicJwk, type Es256KeyPair,
} from '@xaa/crypto';
import { createResourceProtection, type XaaResourceContext } from '../src/protect.js';

const AS_ISSUER = 'https://resource-finance-as.test';
const RESOURCE = 'https://resource-finance-api.test';
const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

async function publicJwk(pair: Es256KeyPair): Promise<JsonWebKey> {
  return webcrypto.subtle.exportKey('jwk', pair.publicKey);
}

/**
 * One request through the guard, built the way the Resource AS builds a token.
 *
 * The claims are minted here rather than stubbed so the names are part of the test: a
 * guard that reads a claim the AS never writes looks perfectly healthy from the inside.
 */
interface CallOptions {
  /** Claims merged over the ones a healthy Resource AS mints. */
  payload?: Record<string, unknown>;
  /** Claim names to leave out entirely. */
  omit?: string[];
  header?: Record<string, unknown>;
  requiredScopes?: string[];
  isRevokedActor?: (actorUrn: string) => Promise<boolean>;
}

async function request(options: CallOptions = {}): Promise<{ response: Response; seen?: XaaResourceContext }> {
  const signingPair = await generateEs256KeyPair();
  const dpopPair = await generateEs256KeyPair();
  const jkt = await jwkThumbprint(await toPublicJwk(dpopPair.publicKey));
  const issuedAt = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    iss: AS_ISSUER, sub: 'testuser', aud: [RESOURCE, `${AS_ISSUER}/userinfo`],
    scope: 'finance.tx.write', iat: issuedAt, exp: issuedAt + 300,
    act: { sub: `urn:xaa:agent:${AGENT_ID}` }, cnf: { jkt },
    ...options.payload,
  };
  for (const name of options.omit ?? []) delete claims[name];

  const accessToken = await signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: 'as-1', ...options.header } as never,
    payload: claims,
    signer: createLocalEs256Signer({ privateKey: signingPair.privateKey, kid: 'as-1' }),
  });

  let seen: XaaResourceContext | undefined;
  const app = new Hono();
  app.use('/payments/*', createResourceProtection({
    asIssuer: AS_ISSUER,
    resourceUri: RESOURCE,
    jwksUrl: 'https://jwks.test/jwks.json',
    requiredScopes: () => options.requiredScopes ?? ['finance.tx.write'],
    jtiStore: new InMemoryJtiStore(),
    publicBaseUrl: RESOURCE,
    ...(options.isRevokedActor ? { isRevokedActor: options.isRevokedActor } : {}),
    fetchImpl: (async () => Response.json({
      keys: [{ ...(await publicJwk(signingPair)), kid: 'as-1', alg: 'ES256', use: 'sig' }],
    })) as unknown as typeof fetch,
  }));
  app.post('/payments/:id/approve', (context) => {
    seen = context.get('xaa') as XaaResourceContext;
    return context.json({ ok: true });
  });

  const url = `${RESOURCE}/payments/p-1/approve`;
  const response = await app.fetch(new Request(url, {
    method: 'POST',
    headers: {
      Authorization: `DPoP ${accessToken}`,
      DPoP: await createDpopProof({ method: 'POST', url, keyPair: dpopPair, accessToken }),
    },
  }));
  return { response, seen };
}

async function call(payloadExtras: Record<string, unknown>): Promise<XaaResourceContext | undefined> {
  const { response, seen } = await request({ payload: payloadExtras });
  expect(response.status).toBe(200);
  return seen;
}

describe('what the guard hands the resource', () => {
  it('reads the constraints under the name the Resource AS mints them', async () => {
    const context = await call({ xaa_constraints: { max_amount: 1000 } });
    expect(context!.constraints).toEqual({ max_amount: 1000 });
  });

  it('leaves the constraints empty when the token carries none', async () => {
    const context = await call({});
    expect(context!.constraints).toEqual({});
  });

  it('does not accept a bare constraints claim', async () => {
    const context = await call({ constraints: { max_amount: 1 } });
    expect(context!.constraints).toEqual({});
  });

  it('carries the isolation level and the agent id through', async () => {
    const context = await call({ isolation_level: 'full_isolation' });
    expect(context!.isolationLevel).toBe('full_isolation');
    expect(context!.agentId).toBe(AGENT_ID);
    expect(context!.humanSubject).toBe('testuser');
  });
});

/**
 * REQ-01-017 / REQ-05-087 / REQ-08-044. Everything from the scheme check to the proof
 * check answers 401; only a scope shortfall answers 403. Nothing about the caller's
 * service account or the Cloud Run hop is read, so there is no shape of request that
 * skips ahead.
 */
describe('what the guard refuses', () => {
  it('answers 401 invalid_token for a token with no act', async () => {
    const { response } = await request({ omit: ['act'] });
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe('invalid_token');
  });

  it('answers 401 invalid_token for a token with no sub', async () => {
    const { response } = await request({ omit: ['sub'] });
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe('invalid_token');
  });

  it('sends both a DPoP and a Bearer challenge on 401', async () => {
    const { response } = await request({ omit: ['act'] });
    const challenges = response.headers.get('WWW-Authenticate') ?? '';
    expect(challenges).toContain('DPoP error="invalid_token"');
    expect(challenges).toContain('Bearer error="invalid_token"');
  });

  it('answers 401 for a Cloud Run ID Token presented as a bearer credential', async () => {
    const app = new Hono();
    app.use('/payments/*', createResourceProtection({
      asIssuer: AS_ISSUER, resourceUri: RESOURCE, jwksUrl: 'https://jwks.test/jwks.json',
      requiredScopes: () => ['finance.tx.read'], jtiStore: new InMemoryJtiStore(), publicBaseUrl: RESOURCE,
      fetchImpl: (async () => Response.json({ keys: [] })) as unknown as typeof fetch,
    }));
    const response = await app.fetch(new Request(`${RESOURCE}/payments/p-1`, {
      headers: { Authorization: 'Bearer google-issued-id-token' },
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('answers 401 for a token whose typ is not at+jwt', async () => {
    const { response } = await request({ header: { typ: 'jwt' } });
    expect(response.status).toBe(401);
  });

  it('does not accept an aud that only shares a prefix with this resource', async () => {
    const { response } = await request({ payload: { aud: [`${RESOURCE}/extra`, `${AS_ISSUER}/userinfo`] } });
    expect(response.status).toBe(401);
  });

  it('answers 403 insufficient_scope when the write scope is missing', async () => {
    const { response } = await request({ payload: { scope: 'finance.tx.read' } });
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('insufficient_scope');
  });

  it('answers 401 token_revoked once the actor is in the ledger', async () => {
    const { response } = await request({ isRevokedActor: async () => true });
    expect(response.status).toBe(401);
    expect((await response.json() as { error: string }).error).toBe('token_revoked');
  });
});
