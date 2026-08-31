import { describe, expect, it } from 'vitest';
import { createLocalEs256Signer, decodeBase64UrlToString, encodeBase64Url, generateEs256KeyPair, signCompactJws, verifyCompactJws } from '../src/index.js';

describe('compact JWS', () => {
  it('round trips an ES256 signature', async () => {
    const pair = await generateEs256KeyPair();
    const token = await signCompactJws({ header: { alg: 'ES256', typ: 'test+jwt', kid: 'test-1' }, payload: { sub: 'x' }, signer: createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'test-1' }) });
    await expect(verifyCompactJws(token, { publicKey: pair.publicKey, allowedTyp: ['test+jwt'] })).resolves.toMatchObject({ payload: { sub: 'x' } });
  });
  it.each(['jku', 'x5c', 'x5u', 'crit'])('rejects %s header before signature verification', async (name) => {
    const header = encodeBase64Url(JSON.stringify({ alg: 'ES256', typ: 'JWT', [name]: 'x' }));
    const token = `${header}.${encodeBase64Url('{}')}.${encodeBase64Url(new Uint8Array(64))}`;
    await expect(verifyCompactJws(token, { allowedTyp: ['JWT'] })).rejects.toMatchObject({ code: 'invalid_jws_header' });
    expect(JSON.parse(decodeBase64UrlToString(header))[name]).toBe('x');
  });
});
