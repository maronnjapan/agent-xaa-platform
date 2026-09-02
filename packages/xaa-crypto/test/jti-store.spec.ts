import { expect, it } from 'vitest';
import { InMemoryJtiStore } from '../src/index.js';

it('in-memory consume returns false on second call', async () => {
  const store = new InMemoryJtiStore(() => 0);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(true);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(false);
});

it('namespaces are isolated', async () => {
  const store = new InMemoryJtiStore(() => 0);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(true);
  await expect(store.consume('actor-token', 'one', 1)).resolves.toBe(true);
  await expect(store.consume('client-assertion', 'one', 1)).resolves.toBe(true);
  await expect(store.consume('actor-token', 'one', 1)).resolves.toBe(false);
});

it('accepts the same jti again once the ttl has passed', async () => {
  let now = 0;
  const store = new InMemoryJtiStore(() => now);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(true);
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(false);
  now = 1001;
  await expect(store.consume('dpop', 'one', 1)).resolves.toBe(true);
});
