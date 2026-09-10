import { createFirestoreDocumentStore, FirestoreJtiStore, getFirestore } from '@xaa/gcp';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';
import { parseAdminPrincipals } from '@xaa/control-plane-auth';
import type { DocsApiDeps } from './app.js';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment variable: ${key}`);
  return value;
}

export async function createRuntimeDeps(env: NodeJS.ProcessEnv = process.env): Promise<DocsApiDeps & { port: number }> {
  const storeMode = env.STORE_MODE === 'gcp' ? 'gcp' : 'emulator';
  const firestore = getFirestore({ signer: 'kms', vertex: 'fake', pubsub: 'gcp', store: storeMode }, env);
  const resourceUri = required(env, 'RESOURCE');
  return {
    port: Number(env.PORT ?? 8080),
    documents: createFirestoreDocumentStore(firestore, 'resource-docs-api'),
    asIssuer: required(env, 'AS_ISSUER'),
    resourceUri,
    jwksUrl: required(env, 'JWKS_URL'),
    jtiStore: new FirestoreJtiStore(firestore),
    serviceIdentity: {
      async verify(authorization) {
        const token = authorization?.match(/^Bearer (.+)$/)?.[1];
        if (!token) return null;
        try {
          const payload = await verifyGoogleServiceIdentity(token, { audience: resourceUri });
          return typeof payload.email === 'string' ? payload.email : null;
        } catch { return null; }
      },
    },
    lifecycleServiceAccount: required(env, 'LIFECYCLE_SA_EMAIL'),
    automationAppServiceAccount: required(env, 'AUTOMATION_APP_SA_EMAIL'),
    // The console. `PUBLIC_BASE_URL` is the audience an administrator's proxy-attached
    // token names, so without it there is nothing to check a token against and the
    // console is not mounted at all. With it and an empty `ADMIN_PRINCIPALS`, it is
    // mounted and reachable by nobody, which is what an unconfigured deployment should be.
    ...(env.PUBLIC_BASE_URL ? { publicBaseUrl: env.PUBLIC_BASE_URL } : {}),
    adminPrincipals: parseAdminPrincipals(env.ADMIN_PRINCIPALS),
  };
}
