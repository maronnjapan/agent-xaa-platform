import { expect, it, vi } from 'vitest';
import { signIdJag } from '../src/index.js';

it('never signs without cnf', async () => {
  const sign = vi.fn();
  await expect(signIdJag({ iss: 'i', sub: 's', aud: 'a', iat: 1, exp: 2, jti: 'j' }, { kid: 'k', sign })).rejects.toMatchObject({ code: 'cnf_required' });
  expect(sign).not.toHaveBeenCalled();
});
