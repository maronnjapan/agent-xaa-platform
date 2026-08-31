import { describe, expect, it } from 'vitest';
import {
  CLIENT_ASSERTION_TYPE,
  JWT_BEARER_GRANT_TYPE,
  REJECTED_SUBJECT_TOKEN_TYPES,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_JWT,
  TOKEN_TYPE_REFRESH_TOKEN,
} from '../src/grant-types.js';

describe('grant type contract', () => {
  it('JWT_BEARER_GRANT_TYPE equals urn:ietf:params:oauth:grant-type:jwt-bearer', () => {
    expect(JWT_BEARER_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
  });

  it('re-exports the library token type constants byte for byte', () => {
    expect(TOKEN_EXCHANGE_GRANT_TYPE).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(TOKEN_TYPE_ID_TOKEN).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(TOKEN_TYPE_JWT).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(TOKEN_TYPE_REFRESH_TOKEN).toBe('urn:ietf:params:oauth:token-type:refresh_token');
  });

  it('defines the IANA client assertion type', () => {
    expect(CLIENT_ASSERTION_TYPE).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  });

  it('rejects refresh_token as a subject token type', () => {
    expect([...REJECTED_SUBJECT_TOKEN_TYPES]).toEqual([TOKEN_TYPE_REFRESH_TOKEN]);
  });
});
