import { webcrypto } from 'node:crypto';
import type { Es256Signer } from './jws.js';

export function createLocalEs256Signer(input: { privateKey: CryptoKey; kid: string }): Es256Signer {
  return {
    kid: input.kid,
    async sign(data) {
      return new Uint8Array(await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        input.privateKey,
        data,
      ));
    },
  };
}
