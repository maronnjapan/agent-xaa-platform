import { expect, it } from 'vitest';
import { generateEs256KeyPair, jwkThumbprint } from '../src/index.js';

it('thumbprint ignores kid and use', async () => {
  const { publicJwk } = await generateEs256KeyPair();
  expect(await jwkThumbprint(publicJwk)).toBe(await jwkThumbprint({ ...publicJwk, kid: 'x', use: 'sig' }));
});
