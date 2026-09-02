import { describe, expect, it } from 'vitest';
import { firestoreUnderTest } from '@xaa/gcp';
import { createResourceAsStores, OIDC_STORE_COLLECTION } from '../src/store/backend.js';
import { createRedeemableAs } from './helpers.js';

/**
 * T-RES-02 / DEC-IAC-09. The generated provider ships with process-local stores; in
 * Cloud Run that means the instance that issued a token is the only one that knows
 * about it. `STORE_MODE=emulator` runs these against `gcloud emulators firestore`
 * when FIRESTORE_EMULATOR_HOST is set, and against the in-process double otherwise.
 */
describe('the Resource AS stores its grants in Firestore', () => {
  it('writes the issued Access Token and reads it back through the store', async () => {
    const { firestore } = await firestoreUnderTest();
    const { stores, storeAccessToken } = createResourceAsStores(firestore);
    const chain = await createRedeemableAs({}, { stores, storeAccessToken });

    const response = await chain.redeem();
    expect(response.status).toBe(200);
    const accessToken = (await response.json() as { access_token: string }).access_token;

    const stored = await stores.accessTokenStore.get(accessToken) as unknown as {
      sub: string; scope: string[]; act: { sub: string }; cnf_jkt: string; idJagJti: string; idpIssuer: string;
    };
    expect(stored.sub).toBe('testuser');
    expect(stored.act.sub).toBe('urn:xaa:agent:agent-abcdefghijklmnopqrstuvwxyz');
    expect(stored.cnf_jkt).toBe(chain.jkt);
    expect(stored.idJagJti.startsWith('idjag-')).toBe(true);
    expect(stored.idpIssuer).toBe('https://human-idp.test');
  });

  it('keeps everything under this resource\'s own collection', async () => {
    const { firestore } = await firestoreUnderTest();
    const { stores, storeAccessToken } = createResourceAsStores(firestore);
    const chain = await createRedeemableAs({}, { stores, storeAccessToken });
    expect((await chain.redeem()).status).toBe(200);

    const snapshot = await firestore.collection(OIDC_STORE_COLLECTION).get();
    expect(snapshot.docs.length).toBeGreaterThan(0);
    expect(OIDC_STORE_COLLECTION).toBe('oidc_resource_docs_as');
  });

  it('answers with nothing once the entry has expired', async () => {
    const { firestore } = await firestoreUnderTest();
    const { stores } = createResourceAsStores(firestore);
    await stores.accessTokenStore.set('expired-token', {
      sub: 'testuser', scope: ['docs.read'], clientId: 'agent-platform',
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    expect(await stores.accessTokenStore.get('expired-token')).toBeUndefined();
  });
});
