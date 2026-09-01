import { serve } from '@hono/node-server';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { CAPABILITY_TO_SCOPE, readModes, type Capability } from '@xaa/contracts';
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
    /**
     * The consent screen is only opened for a provisioning that is waiting for one.
     * Without this the Bridge had no way to look a transaction up, and every
     * `/{connector}/oauth/start` answered `invalid_transaction` (T-BRIDGE-14).
     *
     * The scopes are derived from the capabilities the Provisioner recorded, through
     * the shared table, so the Bridge never decides for itself what an agent may ask
     * the SaaS for.
     */
    readTransaction: async (transactionId) => {
      const record = await documents.get<{
        status?: string; human_subject?: string; required_capabilities?: string[];
      }>('provisioning_transactions', transactionId);
      if (!record || typeof record.status !== 'string' || typeof record.human_subject !== 'string') return undefined;
      return {
        status: record.status,
        human_subject: record.human_subject,
        required_scopes: [...new Set((record.required_capabilities ?? [])
          .flatMap((capability) => CAPABILITY_TO_SCOPE[capability as Capability] ?? []))],
      };
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
