import type { DocumentStore } from '@xaa/gcp';
import { createJsonProviderStores, type ProviderStores } from '../oidc/store.js';
import { createHumanIdpStoreBackend, type HumanIdpStoreBackend } from './firestore-backend.js';
import { emitRefreshTokenReuse } from '../security/reuse-detection.js';

export interface HumanIdpStores {
  stores: ProviderStores;
  backend: HumanIdpStoreBackend;
}

/**
 * Builds the generated provider's eight stores over one Firestore backend.
 *
 * Grant-wide revocation is wrapped so refresh token reuse is reported exactly once
 * and the whole token family goes with it. The delegating objects are written out
 * rather than spread: the generated stores are classes, and spreading would drop
 * their prototype methods.
 */
export function createHumanIdpStores(store: DocumentStore, now: () => number = () => Date.now()): HumanIdpStores {
  const backend = createHumanIdpStoreBackend(store, now);
  const stores = createJsonProviderStores(backend);
  const refreshTokens = stores.refreshTokenStore;
  const accessTokens = stores.accessTokenStore;

  stores.refreshTokenStore = {
    set: (token, info) => refreshTokens.set(token, info),
    get: (token) => refreshTokens.get(token),
    // OAuth 2.1 §4.3.1: consume marks the rotated token used. Deleting it would make
    // a replay look like "not found" and reuse detection would never fire.
    consume: (token) => refreshTokens.consume(token),
    delete: (token) => refreshTokens.delete(token),
    revoke: (token) => refreshTokens.revoke(token),
    async revokeByGrantId(grantId: string) {
      emitRefreshTokenReuse({ grantId });
      await backend.revokeByGrantId(grantId);
    },
  };

  stores.accessTokenStore = {
    set: (token, info) => accessTokens.set(token, info),
    get: (token) => accessTokens.get(token),
    delete: (token) => accessTokens.delete(token),
    revoke: (token) => accessTokens.revoke(token),
    revokeByGrantId: (grantId: string) => backend.revokeByGrantId(grantId).then(() => undefined),
  };

  return { stores, backend };
}
