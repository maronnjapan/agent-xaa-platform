import { describe, expect, it, vi } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createHumanIdpStores } from '../src/store/provider-stores.js';
import { emitRefreshTokenReuse } from '../src/security/reuse-detection.js';

function stores() {
  return createHumanIdpStores(createFirestoreDocumentStore(createFirestoreDouble(), 'human-idp'));
}

const refreshTokenInfo = {
  sub: 'user-1', clientId: 'agent-platform', scope: ['openid', 'offline_access'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600, grantId: 'grant-1', used: false,
  originalIssuedAt: Math.floor(Date.now() / 1000), authTime: Math.floor(Date.now() / 1000),
};

describe('refresh token rotation', () => {
  it('consume marks used instead of deleting', async () => {
    const { stores: providerStores } = stores();
    await providerStores.refreshTokenStore.set('rt-1', { ...refreshTokenInfo } as never);
    await providerStores.refreshTokenStore.consume('rt-1');
    const stored = await providerStores.refreshTokenStore.get('rt-1');
    expect(stored).toBeDefined();
    expect((stored as { used: boolean }).used).toBe(true);
  });

  it('revokeByGrantId hides the whole token family', async () => {
    const { stores: providerStores } = stores();
    await providerStores.refreshTokenStore.set('rt-1', { ...refreshTokenInfo } as never);
    await providerStores.accessTokenStore.set('at-1', {
      sub: 'user-1', clientId: 'agent-platform', scope: ['openid'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600, grantId: 'grant-1',
    } as never);
    await providerStores.refreshTokenStore.revokeByGrantId('grant-1');
    expect(await providerStores.refreshTokenStore.get('rt-1')).toBeUndefined();
    expect(await providerStores.accessTokenStore.get('at-1')).toBeUndefined();
  });

  it('emits refresh_token_reuse once and never logs the token', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      emitRefreshTokenReuse({ grantId: 'grant-1', clientId: 'agent-platform', subject: 'user-1', jti: 'jti-1' });
    } finally { spy.mockRestore(); }
    const matching = lines.filter((line) => line.includes('refresh_token_reuse'));
    expect(matching).toHaveLength(1);
    expect(matching[0]).not.toMatch(/eyJ/);
    expect(JSON.parse(matching[0]!).fields.grant_id).toBe('grant-1');
  });
});
