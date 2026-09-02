import { describe, expect, it } from 'vitest';
import { exchangeToken, readyBridge } from '../src/testing/harness.js';

/**
 * The ID-JAG the agent presents, verified through maronn's own redeem helpers (RULE-45).
 *
 * Every refusal below answers `invalid_grant`. A wrong `typ`, an issuer nobody trusts
 * and an audience belonging to another service are three different forgeries, and
 * naming which one failed tells whoever sent it which half to fix. The reason goes to
 * the structured log, where the operator can read it and the caller cannot.
 *
 * `grant_type` is the exception: it is not a claim about identity but a statement of
 * which protocol the caller thinks it is speaking, so it gets its own OAuth code.
 */
describe('redeeming an ID-JAG', () => {
  it('valid ID-JAG -> 200', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
  });

  it('typ != oauth-id-jag+jwt -> invalid_grant', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    // DEC-ID-18: under one issuer and one key set, `typ` is the only thing separating an
    // ID-JAG from an Access Token the same OP signed.
    const response = await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey, typ: 'at+jwt' }), dpopKey });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('unknown issuer -> invalid_grant', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    const response = await exchangeToken(harness, {
      idJag: await issuer.mint({ dpopKey, issuer: 'https://attacker.test' }), dpopKey,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('aud of another service -> invalid_grant', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    // DEC-ID-05: the audience is this Bridge's own URL. An ID-JAG minted for the Docs
    // Resource AS is a valid token — for somewhere else.
    const response = await exchangeToken(harness, {
      idJag: await issuer.mint({ dpopKey, audience: 'https://resource-docs-as.test' }), dpopKey,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });

  it('grant_type=...jwt-dpop -> unsupported_grant_type', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    // DEV-06: the draft's `jwt-dpop` is not what this platform speaks, and answering
    // `invalid_grant` would suggest the assertion was the problem.
    const response = await exchangeToken(harness, {
      idJag: await issuer.mint({ dpopKey }), dpopKey,
      grantType: 'urn:ietf:params:oauth:grant-type:jwt-dpop',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported_grant_type' });
  });

  it('fetches the shared key set once inside its TTL', async () => {
    const { harness, issuer, dpopKey } = await readyBridge();
    await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    await exchangeToken(harness, { idJag: await issuer.mint({ dpopKey }), dpopKey });
    // Two exchanges, one fetch: the key set is configuration, not something to re-read
    // per request, and the assertion never says where to read it from.
    expect(harness.outbound.filter((url) => url.includes('jwks.json'))).toHaveLength(1);
  });
});
