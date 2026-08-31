export const XAA_CRYPTO_ERROR_CODES = [
  'invalid_base64url',
  'invalid_jws_header',
  'invalid_signature',
  'invalid_jwk',
  'invalid_dpop_proof',
  'replayed_dpop_proof',
  'dpop_key_binding_mismatch',
  'cnf_required',
  'kms_signature_format',
] as const;

export type XaaCryptoErrorCode = (typeof XAA_CRYPTO_ERROR_CODES)[number];

export class XaaCryptoError extends Error {
  constructor(public readonly code: XaaCryptoErrorCode, message: string = code) {
    super(message);
    this.name = 'XaaCryptoError';
  }
}
