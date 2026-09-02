import { expect, it } from 'vitest';
import { derToRawEcdsaSignature, XaaCryptoError } from '../src/index.js';

it('pads short r and s to 32 bytes', () => {
  const r = new Uint8Array(31).fill(1); const s = new Uint8Array(32).fill(2);
  const der = Uint8Array.from([0x30, 67, 0x02, 31, ...r, 0x02, 32, ...s]);
  const raw = derToRawEcdsaSignature(der, 32);
  expect(raw).toHaveLength(64); expect(raw[0]).toBe(0); expect(raw[32]).toBe(2);
});

it('strips leading zero padding', () => {
  // DER writes a 0x00 in front of an integer whose top bit is set, so a 256-bit r
  // arrives as a 33-byte INTEGER. R||S has no such marker and must stay 64 bytes.
  const r = Uint8Array.from([0, ...new Uint8Array(32).fill(0xff)]);
  const s = new Uint8Array(32).fill(2);
  const der = Uint8Array.from([0x30, 69, 0x02, 33, ...r, 0x02, 32, ...s]);
  const raw = derToRawEcdsaSignature(der, 32);
  expect(raw).toHaveLength(64);
  expect(raw[0]).toBe(0xff);
  expect(raw[32]).toBe(2);
});

it('rejects non-sequence input', () => {
  const s = new Uint8Array(32).fill(2);
  const notASequence = Uint8Array.from([0x02, 32, ...s]);
  expect(() => derToRawEcdsaSignature(notASequence, 32)).toThrowError(new XaaCryptoError('kms_signature_format'));
  expect(() => derToRawEcdsaSignature(new Uint8Array(0), 32)).toThrowError(new XaaCryptoError('kms_signature_format'));
});
