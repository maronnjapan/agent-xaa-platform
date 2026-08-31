import { toCiphertext, type Ciphertext } from '../store/ciphertext.js';

export interface KmsCipher {
  encrypt(keyName: string, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(keyName: string, ciphertext: Uint8Array): Promise<Uint8Array>;
}

/**
 * The refresh token's only representation outside memory.
 *
 * The KMS ciphertext is stored exactly as returned — no base64, no wrapper. Re-encoding
 * would mean a decode step that could fail differently from the encrypt step, and the
 * only thing that has to hold is that what went in comes out.
 */
export function createConnectorCipher(input: { kms: KmsCipher; keyName: string }) {
  return {
    async encryptRefreshToken(plain: string): Promise<Ciphertext> {
      return toCiphertext(await input.kms.encrypt(input.keyName, new TextEncoder().encode(plain)));
    },
    async decryptRefreshToken(cipher: Uint8Array): Promise<string> {
      return new TextDecoder().decode(await input.kms.decrypt(input.keyName, cipher));
    },
  };
}
