import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Storage } from '@google-cloud/storage';
import { createFirestoreDocumentStore, FirestoreJtiStore, getFirestore as createFirestoreClient, type DocumentStore } from '@xaa/gcp';
import type { JtiStore } from '@xaa/crypto';
import type { Envelope, ObjectStore } from './keys/self-bootstrap.js';
import type { HumanIdpEnv } from './env.js';

export function createDocumentStore(env: HumanIdpEnv): DocumentStore {
  if (env.storeMode === 'emulator' && !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is required when STORE_MODE=emulator');
  }
  return createFirestoreDocumentStore(
    createFirestoreClient({ signer: env.signerMode, vertex: 'fake', pubsub: 'inproc', store: env.storeMode }),
    'human-idp',
  );
}

export function createBucketStore(bucketName: string, storage = new Storage()): ObjectStore {
  const bucket = storage.bucket(bucketName);
  return {
    async read(path) {
      const file = bucket.file(path);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [contents] = await file.download();
      return contents.toString('utf8');
    },
    // ifGenerationMatch: 0 is the create-if-absent precondition. Two cold starts
    // racing here means one gets 412 and reads the winner's object; no lock object.
    async createIfAbsent(path, body) {
      await bucket.file(path).save(body, { preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'application/json' });
    },
    async write(path, body, options) {
      await bucket.file(path).save(body, { contentType: 'application/json' });
      if (options?.public) await bucket.file(path).makePublic().catch(() => undefined);
    },
  };
}

export function createKmsEnvelope(keyName: string, client = new KeyManagementServiceClient()): Envelope {
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

export function createJtiStore(env: HumanIdpEnv): JtiStore {
  return new FirestoreJtiStore(createFirestoreClient({ signer: env.signerMode, vertex: 'fake', pubsub: 'inproc', store: env.storeMode }));
}
