import { expect, it } from 'vitest';
import { InMemoryJtiStore } from '../src/index.js';

it('in-memory consume returns false on second call and namespaces are isolated', async () => {
  let now = 0;
  const store = new InMemoryJtiStore(() => now);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(true);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(false);
  await expect(store.consume('actor-token', 'one', 1)).resolves.toBe(true);
  now = 1001;
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(true);
});
