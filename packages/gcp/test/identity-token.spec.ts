import { describe, expect, it, vi } from 'vitest';
import { createIdentityTokenProvider, type IdTokenAuth } from '../src/identity-token.js';

describe('Cloud Run identity token provider', () => {
  it('uses the destination as audience and caches only the client', async () => {
    const fetchIdToken = vi.fn(async (audience: string) => `token:${audience}`);
    const getIdTokenClient = vi.fn(async () => ({ idTokenProvider: { fetchIdToken } }));
    const provider = createIdentityTokenProvider({ getIdTokenClient } as IdTokenAuth);

    expect(await provider('https://service.example')).toBe('token:https://service.example');
    expect(await provider('https://service.example')).toBe('token:https://service.example');
    expect(getIdTokenClient).toHaveBeenCalledTimes(1);
    expect(fetchIdToken).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-HTTPS remote audience', async () => {
    const provider = createIdentityTokenProvider({ getIdTokenClient: vi.fn() } as unknown as IdTokenAuth);
    await expect(provider('http://service.example')).rejects.toThrow(/absolute HTTPS/);
  });
});
