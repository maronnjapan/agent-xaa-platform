import { describe, expect, it } from 'vitest';
import * as surface from '../src/library-surface.js';

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
    for (const name of expected) expect(surface[name], name).not.toBeUndefined();
  });
  it('keeps protocol constants byte exact', () => {
    expect(surface.ID_JAG_JWT_TYP).toBe('oauth-id-jag+jwt');
    expect(surface.JWT_BEARER_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });
});
