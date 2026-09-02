import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';
import { createKmsEs256Signer } from '@xaa/crypto/kms';
import { createFirestoreDocumentStore, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';
import { loadConfig, type AgentOpConfig } from './config.js';
import type { AgentOpAppDeps } from './app.js';
import { createKmsEnvelopeCipher } from './idp-connection/crypto.js';
import { assertJwkSet, type JwkSet } from './keys/shared-jwks.js';
import { resolveKeyBinding } from './keys/dedicated-key.js';
import { publishPublicKeyOnStartup } from './keys/publish-public-key.js';
import type { ActivityEvent, ActivityPublisher } from './log/protocol-violation-event.js';

/**
 * Everything that talks to GCP is built here, once, at startup. `createApp` takes it
 * all as arguments so integration tests can substitute in-process doubles.
 *
 * The environment arrives already parsed: `config.ts` is the only module that reads
 * it, so the deployment contract cannot grow a variable in a corner of the
 * composition root.
 */
export async function createRuntimeDeps(config: AgentOpConfig = loadConfig()): Promise<AgentOpAppDeps & { port: number }> {
  const storage = new Storage();
  const firestore = getFirestore({ signer: config.signerMode, vertex: 'fake', pubsub: 'gcp', store: config.storeMode });
  const binding = resolveKeyBinding(config);

  // MODE=callback never signs an ID-JAG, so it never constructs a KMS signing client.
  const kms = config.mode === 'token' ? new KeyManagementServiceClient() : undefined;
  const signer = kms
    ? createKmsEs256Signer({ keyVersionName: binding.keyVersionName, kidPrefix: binding.kidPrefix, client: kms })
    : { kid: `${binding.kidPrefix}-0`, async sign() { throw new Error('the callback mode does not sign'); } };

  const deps: AgentOpAppDeps & { port: number } = {
    port: config.port ?? 8080,
    config,
    documents: createFirestoreDocumentStore(firestore, 'agent-op'),
    jtiStore: new FirestoreJtiStore(firestore),
    signer,
    jwksSource: {
      async read(): Promise<JwkSet> {
        const [contents] = await storage.bucket(config.jwksBucket).file(config.jwksObject).download();
        const parsed: unknown = JSON.parse(contents.toString('utf8'));
        assertJwkSet(parsed);
        return parsed;
      },
    },
    envelope: createKmsEnvelopeCipher(config.kmsIdpConnectionKey, (kms ?? new KeyManagementServiceClient()) as never),
    publisher: createPubSubPublisher(),
    revision: config.revision ?? 'local',
    ...(config.automationAppUrl ? { automationAppUrl: config.automationAppUrl } : {}),
  };

  if (config.mode === 'token') {
    deps.serviceIdentity = {
      async verify(authorization) {
        const token = authorization?.match(/^Bearer (.+)$/)?.[1];
        if (!token) return null;
        try {
          const payload = await verifyGoogleServiceIdentity(token, { audience: config.publicBaseUrl });
          return typeof payload.email === 'string' ? payload.email : null;
        } catch { return null; }
      },
    };
    deps.lifecycleServiceAccount = config.lifecycleServiceAccount ?? '';
    deps.provisionerServiceAccount = config.provisionerServiceAccount ?? '';
  }
  // Refusing to start beats issuing grants whose key is absent from the JWK Set. The
  // mode guard lives inside the helper so `MODE=callback` provably publishes nothing.
  await publishPublicKeyOnStartup({
    mode: config.mode, storage, bucket: config.jwksBucket, kid: signer.kid,
    readPublicJwk: () => fetchPublicJwk(kms!, binding.keyVersionName),
  });
  return deps;
}

async function fetchPublicJwk(client: KeyManagementServiceClient, keyVersionName: string): Promise<JsonWebKey> {
  const { fetchKmsPublicJwk } = await import('@xaa/crypto/kms');
  return fetchKmsPublicJwk(keyVersionName, client) as unknown as JsonWebKey;
}

function createPubSubPublisher(): ActivityPublisher {
  const pubsub = new PubSub();
  return {
    async publish(topic: string, event: ActivityEvent): Promise<void> {
      await pubsub.topic(topic).publishMessage({ json: event });
    },
  };
}
