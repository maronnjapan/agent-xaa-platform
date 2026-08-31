import { serve } from '@hono/node-server';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { readModes } from '@xaa/contracts';
import { createFirestoreDocumentStore, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import createApp from './index.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const firestore = getFirestore(readModes(process.env));
const documents = createFirestoreDocumentStore(firestore, 'google-bridge');
const secrets = new SecretManagerServiceClient();
const kms = new KeyManagementServiceClient();

serve({
  fetch: createApp({
    config,
    documents,
    // Firestore, not an in-memory Map: Cloud Run runs several instances, and a
    // replayed proof must be caught whichever one receives it.
    jtiStore: new FirestoreJtiStore(firestore),
    kms: {
      async encrypt(keyName, plaintext) {
        const [response] = await kms.encrypt({ name: keyName, plaintext });
        return response.ciphertext as Uint8Array;
      },
      async decrypt(keyName, ciphertext) {
        const [response] = await kms.decrypt({ name: keyName, ciphertext });
        return response.plaintext as Uint8Array;
      },
    },
    // Read per call, never cached in a module variable: a rotated secret must take
    // effect without a redeploy.
    readSecret: async (secretName) => {
      const [version] = await secrets.accessSecretVersion({ name: `${secretName}/versions/latest` });
      return version.payload?.data?.toString() ?? '';
    },
  }).fetch,
  port: Number(process.env.PORT ?? 8080),
});
