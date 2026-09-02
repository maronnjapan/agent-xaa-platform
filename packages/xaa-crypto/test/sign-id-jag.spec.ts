import { expect, it, vi } from 'vitest';
import { createLocalEs256Signer, decodeJwsUnverified, generateEs256KeyPair, signIdJag } from '../src/index.js';

const claims = { iss: 'i', sub: 's', aud: 'a', iat: 1, exp: 2, jti: 'j', cnf: { jkt: 'thumbprint' } };

it('never signs without cnf', async () => {
  const sign = vi.fn();
  await expect(signIdJag({ iss: 'i', sub: 's', aud: 'a', iat: 1, exp: 2, jti: 'j' }, { kid: 'k', sign })).rejects.toMatchObject({ code: 'cnf_required' });
  expect(sign).not.toHaveBeenCalled();
});

it('never signs with an empty cnf.jkt', async () => {
  const sign = vi.fn();
  await expect(signIdJag({ ...claims, cnf: { jkt: '' } }, { kid: 'k', sign })).rejects.toMatchObject({ code: 'cnf_required' });
  expect(sign).not.toHaveBeenCalled();
});

it('signature accepts no typ argument', () => {
  // Two parameters only: claims and signer. A caller cannot pick the typ, which is
  // what keeps every ID-JAG on the one header this platform verifies against.
  expect(signIdJag.length).toBe(2);
});

it('always emits typ oauth-id-jag+jwt', async () => {
  const pair = await generateEs256KeyPair();
  const token = await signIdJag(claims, createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'idjag-1' }));
  expect(decodeJwsUnverified(token).header).toMatchObject({ alg: 'ES256', typ: 'oauth-id-jag+jwt', kid: 'idjag-1' });
});
