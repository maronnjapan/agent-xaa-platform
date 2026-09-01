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
async function call(payloadExtras: Record<string, unknown>): Promise<XaaResourceContext | undefined> {
  const signingPair = await generateEs256KeyPair();
  const dpopPair = await generateEs256KeyPair();
  const jkt = await jwkThumbprint(await toPublicJwk(dpopPair.publicKey));
  const issuedAt = Math.floor(Date.now() / 1000);

  const accessToken = await signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: 'as-1' },
    payload: {
      iss: AS_ISSUER, sub: 'testuser', aud: [RESOURCE, `${AS_ISSUER}/userinfo`],
      scope: 'finance.tx.write', iat: issuedAt, exp: issuedAt + 300,
      act: { sub: `urn:xaa:agent:${AGENT_ID}` }, cnf: { jkt },
      ...payloadExtras,
    },
    signer: createLocalEs256Signer({ privateKey: signingPair.privateKey, kid: 'as-1' }),
  });

  let seen: XaaResourceContext | undefined;
  const app = new Hono();
  app.use('/payments/*', createResourceProtection({
    asIssuer: AS_ISSUER,
    resourceUri: RESOURCE,
    jwksUrl: 'https://jwks.test/jwks.json',
    requiredScopes: () => ['finance.tx.write'],
    jtiStore: new InMemoryJtiStore(),
    publicBaseUrl: RESOURCE,
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
