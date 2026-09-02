import { describe, expect, it } from 'vitest';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws } from '@xaa/crypto';
import * as surface from '../src/library-surface.js';
import type { IdJagActorTokenResolverInput } from '../src/library-surface.js';

const expected = [
  'authorizeIdJagIssuanceClient', 'parseIdJagIssuanceParams', 'resolveIdJagSubject',
  'resolveIdJagActorToken', 'validateIdJagAudience', 'validateIdJagScope',
  'buildIdJagClaims', 'createIdJagJwt', 'buildIdJagIssuanceResponse',
  'processIdJagIssuanceRequest', 'parseIdJagRedemptionParams', 'verifyIdJagAssertion',
  'authorizeIdJagRedemptionClient', 'resolveIdJagGrantScope', 'IdJagError',
  'ID_JAG_JWT_TYP', 'ID_JAG_TOKEN_TYPE', 'TOKEN_EXCHANGE_GRANT_TYPE',
  'JWT_BEARER_GRANT_TYPE', 'TOKEN_TYPE_ID_TOKEN', 'TOKEN_TYPE_JWT',
  'TOKEN_TYPE_REFRESH_TOKEN', 'ACTOR_TOKEN_TYPES_SUPPORTED',
] as const;

describe('maronn 0.2.0 / experimental 0.0.6 contract', () => {
  it('exposes the complete pinned surface', () => {
    // 23 runtime exports plus the IdJagActorTokenResolverInput type make the 24 the
    // platform depends on; the type is pinned by its own test below.
    expect(expected).toHaveLength(23);
    expect(Object.keys(surface).sort()).toEqual([...expected].sort());
    for (const name of expected) expect(surface[name], name).not.toBeUndefined();
  });
  it('keeps protocol constants byte exact', () => {
    expect(surface.ID_JAG_JWT_TYP).toBe('oauth-id-jag+jwt');
    expect(surface.JWT_BEARER_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('verifyIdJagAssertion requires aud to equal issuer', async () => {
    const IDP_ISSUER = 'https://human-idp.test';
    const AS_ISSUER = 'https://resource-docs-as.test';
    const pair = await generateEs256KeyPair();
    const signer = createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'idp-1' });
    const identityProviders = [{ issuer: IDP_ISSUER, jwks: { keys: [{ ...pair.publicJwk, kid: 'idp-1', alg: 'ES256', use: 'sig' }] } }];
    const now = Math.floor(Date.now() / 1000);
    const assertionWith = (aud: string) => signCompactJws({
      header: { alg: 'ES256', typ: surface.ID_JAG_JWT_TYP, kid: signer.kid },
      payload: { iss: IDP_ISSUER, sub: 'user-1', aud, client_id: 'agent-platform', jti: `j-${aud}`, iat: now, exp: now + 300 },
      signer,
    });
    const verify = (assertion: string) => surface.verifyIdJagAssertion({
      assertion, issuer: AS_ISSUER, clientId: 'agent-platform', identityProviders,
    });
    // DEC-ID-05 rests on this: the aud of an ID-JAG is the Resource AS issuer, an
    // https URL. A urn:xaa:... audience is not accepted by the library.
    await expect(verify(await assertionWith('urn:xaa:resource:docs'))).rejects.toBeInstanceOf(surface.IdJagError);
    await expect(verify(await assertionWith(AS_ISSUER))).resolves.toMatchObject({ aud: AS_ISSUER, sub: 'user-1' });
  });

  it('IdJagActorTokenResolverInput has no subject field', () => {
    const input: IdJagActorTokenResolverInput = {
      actorToken: 'token', actorTokenType: surface.TOKEN_TYPE_JWT,
      clientId: 'agent-platform', issuer: 'https://human-idp.test', jwks: { keys: [] },
    };
    expect(Object.keys(input).sort()).toEqual(['actorToken', 'actorTokenType', 'clientId', 'issuer', 'jwks']);
    // DEC-ID-07: the resolver never learns who the subject is, so the delegation
    // check (RULE-49) cannot live inside it and stays in the Agent OP.
    // @ts-expect-error subject is not part of the resolver input
    expect(input.subject).toBeUndefined();
  });
});
