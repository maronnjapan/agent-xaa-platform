import { sha256 } from '@xaa/crypto';

export interface EnvelopeCipher {
  /** AAD binds the ciphertext to one agent, so another agent cannot replay it. */
  encrypt(plaintext: string, aad: string): Promise<string>;
  decrypt(ciphertext: string, aad: string): Promise<string>;
}

/**
 * REQ-05-045. The refresh token never rests in Firestore in the clear and never
 * appears in a log. `agent_id` is passed as additional authenticated data, so a
 * ciphertext copied to another agent's record simply fails to decrypt.
 */
export function createKmsEnvelopeCipher(keyName: string, client: {
  encrypt(request: { name: string; plaintext: Buffer; additionalAuthenticatedData: Buffer }): Promise<[{ ciphertext?: Uint8Array | string | null }]>;
  decrypt(request: { name: string; ciphertext: Buffer; additionalAuthenticatedData: Buffer }): Promise<[{ plaintext?: Uint8Array | string | null }]>;
}): EnvelopeCipher {
  return {
    async encrypt(plaintext, aad) {
      const [response] = await client.encrypt({
        name: keyName, plaintext: Buffer.from(plaintext, 'utf8'), additionalAuthenticatedData: Buffer.from(aad, 'utf8'),
      });
      if (!response.ciphertext) throw new Error('KMS returned no ciphertext');
      return Buffer.from(response.ciphertext as Uint8Array).toString('base64');
    },
    async decrypt(ciphertext, aad) {
      const [response] = await client.decrypt({
        name: keyName, ciphertext: Buffer.from(ciphertext, 'base64'), additionalAuthenticatedData: Buffer.from(aad, 'utf8'),
      });
      if (!response.plaintext) throw new Error('KMS returned no plaintext');
      return Buffer.from(response.plaintext as Uint8Array).toString('utf8');
    },
  };
}

/** Used only inside reuse detection; never logged and never stored beside the record. */
export async function refreshTokenFingerprint(refreshToken: string): Promise<string> {
  const digest = await sha256(refreshToken);
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
