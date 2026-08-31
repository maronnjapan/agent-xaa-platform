/**
 * A refresh token that has been through KMS, and nothing else.
 *
 * The brand exists so `saveEncryptedRefreshToken` cannot be handed a string. Without
 * it, the difference between a plaintext token and its ciphertext is a convention;
 * with it, writing the plaintext to Firestore is a compile error.
 *
 * Only `toCiphertext` produces the type, and only the KMS client calls it.
 */
export type Ciphertext = Uint8Array & { readonly __brand: 'kms-ciphertext' };

/** Called by the KMS wrapper on an Encrypt response, and by nothing else. */
export function toCiphertext(bytes: Uint8Array): Ciphertext {
  return bytes as Ciphertext;
}
