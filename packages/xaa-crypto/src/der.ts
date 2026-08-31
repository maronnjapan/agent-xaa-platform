import { XaaCryptoError } from './errors.js';

function readLength(input: Uint8Array, offset: number): [number, number] {
  const first = input[offset];
  if (first === undefined) throw new XaaCryptoError('kms_signature_format');
  if ((first & 0x80) === 0) return [first, offset + 1];
  const count = first & 0x7f;
  if (count < 1 || count > 2 || offset + count >= input.length) throw new XaaCryptoError('kms_signature_format');
  let value = 0;
  for (let index = 0; index < count; index += 1) value = value * 256 + input[offset + 1 + index]!;
  return [value, offset + 1 + count];
}

function integer(input: Uint8Array, offset: number, size: number): [Uint8Array, number] {
  if (input[offset] !== 0x02) throw new XaaCryptoError('kms_signature_format');
  const [length, start] = readLength(input, offset + 1);
  const end = start + length;
  if (length < 1 || end > input.length) throw new XaaCryptoError('kms_signature_format');
  let value = input.slice(start, end);
  while (value.length > 1 && value[0] === 0) value = value.slice(1);
  if (value.length > size) throw new XaaCryptoError('kms_signature_format');
  const padded = new Uint8Array(size);
  padded.set(value, size - value.length);
  return [padded, end];
}

export function derToRawEcdsaSignature(der: Uint8Array, coordinateBytes: number): Uint8Array {
  if (der[0] !== 0x30) throw new XaaCryptoError('kms_signature_format');
  const [length, body] = readLength(der, 1);
  if (body + length !== der.length) throw new XaaCryptoError('kms_signature_format');
  const [r, afterR] = integer(der, body, coordinateBytes);
  const [s, afterS] = integer(der, afterR, coordinateBytes);
  if (afterS !== der.length) throw new XaaCryptoError('kms_signature_format');
  const raw = new Uint8Array(coordinateBytes * 2);
  raw.set(r, 0);
  raw.set(s, coordinateBytes);
  return raw;
}
