import { createFirestoreJsonStoreBackend } from '@xaa/gcp';
import { createJsonProviderStores, type ProviderStores } from '../oidc/store.js';

/** The one collection this AS may touch (00b, `firestore-guard` access matrix). */
export const OIDC_STORE_COLLECTION = 'oidc_resource_docs_as';

/**
 * The Firestore client type, taken from the shared factory so this app never has to
 * depend on `@google-cloud/firestore` directly (DEC-APP-04).
 */
type FirestoreClient = Parameters<typeof createFirestoreJsonStoreBackend>[0]['firestore'];

export interface ResourceAsStores {
  stores: ProviderStores;
  /**
   * Records what was issued: `act`, `cnf_jkt`, the trusted issuer and the redeemed
   * ID-JAG's `jti`. T-RES-22's bulk revocation walks these rows by `act.sub`, so a
   * process-local store would lose every token the moment the instance recycled.
   */
  storeAccessToken(token: string, info: Record<string, unknown>): Promise<void>;
}

/**
 * The generated provider's eight stores over one Firestore collection (T-RES-02).
 *
 * The collection is fixed at construction, so a key this app writes cannot land in
 * another app's data no matter what prefix the generated code chooses.
 */
export function createResourceAsStores(firestore: FirestoreClient): ResourceAsStores {
  const stores = createJsonProviderStores(
    createFirestoreJsonStoreBackend({ firestore, collection: OIDC_STORE_COLLECTION }),
  );
  return {
    stores,
    async storeAccessToken(token, info) {
      await stores.accessTokenStore.set(token, info as never);
    },
  };
}
