import { PubSub } from '@google-cloud/pubsub';
import { createFirestoreDocumentStore, createIdentityTokenProvider, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import { createVertexClient } from '@xaa/vertex';
import { loadConfig } from './config.js';
import { createReprovisionClient } from './reevaluate/reprovision-client.js';
import type { AuthorizationDeps } from './app.js';

export async function createRuntimeDeps(env: NodeJS.ProcessEnv = process.env): Promise<AuthorizationDeps & { port: number }> {
  const config = loadConfig(env);
  const firestore = getFirestore({ signer: 'kms', vertex: config.vertexMode, pubsub: config.pubsubMode, store: config.storeMode }, env);
  const pubsub = config.pubsubMode === 'gcp' ? new PubSub() : undefined;
  return {
    port: config.port,
    config,
    documents: createFirestoreDocumentStore(firestore, 'authorization'),
    vertex: createVertexClient({
      mode: config.vertexMode, project: config.projectId,
      location: config.vertexLocation, model: config.vertexModel,
    }),
    jtiStore: new FirestoreJtiStore(firestore),
    ...(pubsub ? {
      publishActivity: async (event: Record<string, unknown>) => {
        await pubsub.topic(config.activityTopic).publishMessage({ json: event });
      },
    } : {}),
    // Lifecycle owns the transition; Authorization only asks, over a call its own
    // service account is named for (`ALLOWED_CALLER_SAS`).
    requestReprovision: createReprovisionClient({
      lifecycleBaseUrl: config.lifecycleManagerUrl,
      identityToken: createIdentityTokenProvider(),
    }),
  };
}
