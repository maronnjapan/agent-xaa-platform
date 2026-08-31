import { expect, it } from 'vitest';
import { mergeJwksEntries } from '../src/index.js';

it('deduplicates by kid keeping the newer entry', () => {
  const merged = mergeJwksEntries([
    { jwk: { kid: 'idp-a', value: 'old' }, updated: 1 },
    { jwk: { kid: 'idp-a', value: 'new' }, updated: 2 },
    { jwk: { kid: 'unknown-a' }, updated: 3 },
  ]);
  expect(merged).toEqual({ keys: [{ kid: 'idp-a', value: 'new' }], skipped: 1 });
});
