import { expect, it } from 'vitest';
import { derToRawEcdsaSignature } from '../src/index.js';

it('pads short r and s to 32 bytes', () => {
  const r = new Uint8Array(31).fill(1); const s = new Uint8Array(32).fill(2);
  const der = Uint8Array.from([0x30, 67, 0x02, 31, ...r, 0x02, 32, ...s]);
  const raw = derToRawEcdsaSignature(der, 32);
  expect(raw).toHaveLength(64); expect(raw[0]).toBe(0); expect(raw[32]).toBe(2);
});
