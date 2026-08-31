import { expect, it } from 'vitest';
import { sha256Base64Url } from '../src/index.js';

it('hashes an empty string', async () => {
  await expect(sha256Base64Url('')).resolves.toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
});
