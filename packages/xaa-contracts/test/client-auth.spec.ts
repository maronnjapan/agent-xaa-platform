import { describe, expect, it } from 'vitest';
import { extractClientCredentials, verifyClientSecret } from '@maronn-openid-connect/core';
import { basicClientAuthHeader } from '../src/client-auth.js';

/**
 * The header is only correct if the server takes back out what the client put in, so
 * every case below is checked against the real decoder rather than against a second
 * hand-written encoder that could drift the same way the first one did.
 */
const decode = (header: string) => extractClientCredentials({ params: {}, authorizationHeader: header });

/** What `openssl rand -base64 48` produces: `+`, `/` and the padding `=`. */
const BASE64_SECRET = 'ab+cd/ef+gh/ij+kl/mn+op/qr+st/uv+wx/yz+AB/CD+EF/GH=';

describe('basicClientAuthHeader', () => {
  it('round-trips a base64 secret through the server decoder', () => {
    const presented = decode(basicClientAuthHeader('agent-platform', BASE64_SECRET));
    expect(presented.clientId).toBe('agent-platform');
    expect(presented.clientSecret).toBe(BASE64_SECRET);
  });

  /**
   * The bug this file exists for. A raw `+` is form-url-decoded back as a space, so
   * the Human IdP compared the secret against one with spaces in it and answered 401
   * invalid_client; the Agent OP's authorization_code exchange failed and the person
   * consenting to offline_access got the "認可を完了できませんでした" page.
   */
  it('survives the plus that the unencoded header turned into a space', async () => {
    const raw = `Basic ${Buffer.from(`agent-platform:${BASE64_SECRET}`).toString('base64')}`;
    expect(decode(raw).clientSecret).not.toBe(BASE64_SECRET);

    const client = { clientId: 'agent-platform', clientSecret: BASE64_SECRET, tokenEndpointAuthMethod: 'client_secret_basic' as const };
    await expect(verifyClientSecret(client, decode(raw).clientSecret)).rejects.toThrow();
    await expect(verifyClientSecret(client, decode(basicClientAuthHeader('agent-platform', BASE64_SECRET)).clientSecret)).resolves.toBeUndefined();
  });

  it('round-trips the reserved characters a hand-rotated secret can carry', () => {
    for (const secret of [':', '%20', 'a b', 'a:b', '=', '&x=1', '日本語', '']) {
      expect(decode(basicClientAuthHeader('agent-platform', secret)).clientSecret).toBe(secret);
    }
  });

  it('splits on the separating colon, not on one inside the secret', () => {
    const presented = decode(basicClientAuthHeader('agent-platform', 'a:b:c'));
    expect(presented.clientId).toBe('agent-platform');
    expect(presented.clientSecret).toBe('a:b:c');
  });

  it('reports client_secret_basic so the registered auth method matches', () => {
    expect(decode(basicClientAuthHeader('agent-platform', BASE64_SECRET)).method).toBe('client_secret_basic');
  });
});
