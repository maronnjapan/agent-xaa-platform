import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Storage } from '@google-cloud/storage';
import { createFirestoreDocumentStore, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import { createRevocationLedger } from '@xaa/resource-guard';
import type { ResourceAsDeps } from './app.js';
import { loadResourceAsEnv } from './config/env.js';
import { ensureSigningKey, localSigningKey, type Envelope, type ObjectStore } from './keys/self-bootstrap.js';

export async function createRuntimeDeps(env: NodeJS.ProcessEnv = process.env): Promise<ResourceAsDeps & { port: number }> {
  const configuration = loadResourceAsEnv(env);
  const firestore = getFirestore({ signer: configuration.signerMode, vertex: 'fake', pubsub: 'gcp', store: configuration.storeMode }, env);
  const documents = createFirestoreDocumentStore(firestore, configuration.asKind === 'finance' ? 'resource-finance-as' : 'resource-docs-as');
  const ledger = createRevocationLedger(documents);

  const signingKey = configuration.signerMode === 'local'
    ? await localSigningKey(env.LOCAL_SIGNING_JWK ?? '{}', configuration.jwksKeyPrefix)
    : await ensureSigningKey({
      store: bucketStore(configuration.signingKeyBucket),
      jwksStore: bucketStore(configuration.jwksBucket),
      envelope: kmsEnvelope(configuration.signingKeyKmsKey),
      objectPath: configuration.signingKeyObject,
      kidPrefix: configuration.jwksKeyPrefix,
    });

  return {
    port: configuration.port,
    env: configuration,
    signingKey,
    jtiStore: new FirestoreJtiStore(firestore),
    isActorRevoked: (actorUrn) => ledger.isActorRevoked(actorUrn),
    ...(env.REQUIRE_ISOLATION_LEVEL ? { requireIsolationLevel: env.REQUIRE_ISOLATION_LEVEL } : {}),
  };
}

function bucketStore(bucketName: string, storage = new Storage()): ObjectStore {
  const bucket = storage.bucket(bucketName);
  return {
    async read(path) {
      const file = bucket.file(path);
      const [exists] = await file.exists();
      if (!exists) return null;
      return (await file.download())[0].toString('utf8');
    },
    async createIfAbsent(path, body) {
      await bucket.file(path).save(body, { preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'application/json' });
    },
    async write(path, body) { await bucket.file(path).save(body, { contentType: 'application/json' }); },
  };
}

function kmsEnvelope(keyName: string, client = new KeyManagementServiceClient()): Envelope {
  return {
    async encrypt(plaintext) {
      const [response] = await client.encrypt({ name: keyName, plaintext: Buffer.from(plaintext, 'utf8') });
      return Buffer.from(response.ciphertext as Uint8Array).toString('base64');
    },
    async decrypt(ciphertext) {
      const [response] = await client.decrypt({ name: keyName, ciphertext: Buffer.from(ciphertext, 'base64') });
      return Buffer.from(response.plaintext as Uint8Array).toString('utf8');
    },
  };
}
