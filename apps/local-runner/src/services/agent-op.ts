import createAgentOp, { type AgentOpAppDeps } from '@xaa/agent-op/app';
import type { AgentOpConfig } from '@xaa/agent-op/src/config';
import { createKmsEnvelopeCipher } from '@xaa/agent-op/src/idp-connection/crypto';
import { resolveKeyBinding } from '@xaa/agent-op/src/keys/dedicated-key';
import type { JwkSet } from '@xaa/agent-op/src/keys/shared-jwks';
import { createLocalEs256Signer, generateEs256KeyPair } from '@xaa/crypto';
import { FirestoreJtiStore, createFirestoreDocumentStore } from '@xaa/gcp';
import { publishable } from '../local/jwks.js';
import { listen, type Listener } from '../local/serve.js';
import type { LocalPlatform } from '../platform.js';

/**
 * The Agent OP's environment, exactly as `services.tf` builds it for the two deployed
 * faces and for every Dedicated one the Provisioner creates.
 *
 * Both faces run the same image and differ only by `MODE`: the token face signs
 * ID-JAGs and is internal, the callback face is the only part a browser reaches. That
 * split is a Cloud Run ingress setting on GCP and two ports here, but the routes each
 * mounts are decided by this one variable either way.
 */
export function agentOpEnvironment(platform: LocalPlatform, face: 'token' | 'callback'): Record<string, string> {
  const { url, projectId } = platform.config.topology;
  const self = face === 'token' ? url['shared-agent-op'] : url['agent-op-callback'];
  return {
    MODE: face,
    ISSUER: platform.config.topology.endpoints.issuer,
    PUBLIC_BASE_URL: self,
    XAA_CLIENT_ID: 'agent-platform',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE: 'xaa-db',
    JWKS_BUCKET: 'local-jwks',
    JWKS_OBJECT: 'jwks.json',
    KMS_IDJAG_KEY: platform.keys.sharedAgentOpIdJag,
    KMS_IDP_CONNECTION_KEY: platform.keys.idpConnection,
    HUMAN_IDP_AUTHORIZE_URL: `${url['human-idp']}/authorize`,
    HUMAN_IDP_TOKEN_URL: `${url['human-idp']}/token`,
    HUMAN_IDP_REVOKE_URL: `${url['human-idp']}/revoke`,
    AGENT_OP_CALLBACK_URL: url['agent-op-callback'],
    CLIENT_SECRET_AGENT_PLATFORM: platform.secrets.agentPlatform,
    PROVISIONER_SA_EMAIL: platform.accounts.provisioner!,
    LIFECYCLE_SA_EMAIL: platform.accounts.lifecycle!,
    ID_JAG_LIFETIME_SECONDS: '300',
    SIGNER_MODE: 'local',
    STORE_MODE: 'emulator',
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    AUTOMATION_APP_URL: url['automation-app'],
  };
}

/**
 * One Agent OP, shared or dedicated, with GCP replaced where it is GCP and nowhere
 * else.
 *
 * Three things are local: the ID-JAG signing key (an ES256 key in this process rather
 * than a KMS key version, published into the aggregate JWK Set under the same kid the
 * deployment would use), the envelope that protects a refresh token at rest, and the
 * Cloud Run identity check on the two internal routes. Everything above them — the
 * token exchange, the client assertion, the DPoP proof, the agent binding — is the
 * deployed code, unmodified.
 */
export async function createAgentOpApp(platform: LocalPlatform, config: AgentOpConfig): Promise<{
  fetch(request: Request): Response | Promise<Response>;
  kid: string;
}> {
  const binding = resolveKeyBinding(config);
  const keyPair = await generateEs256KeyPair();
  // 00b: the kid is `<prefix>-<key version>`, and a runtime key has exactly one version.
  const kid = `${binding.kidPrefix}-1`;
  const signer = config.mode === 'token'
    ? createLocalEs256Signer({ privateKey: keyPair.privateKey, kid })
    : { kid, async sign(): Promise<Uint8Array> { throw new Error('the callback mode does not sign'); } };

  // T-OP-05: a token-face OP publishes its public key before it serves, because a grant
  // signed with a key absent from the set is a grant no Resource Server can verify.
  if (config.mode === 'token') platform.jwks.publish(publishable(keyPair.publicJwk, kid, 'ES256'));

  const deps: AgentOpAppDeps = {
    config,
    documents: createFirestoreDocumentStore(platform.firestore, 'agent-op'),
    jtiStore: new FirestoreJtiStore(platform.firestore),
    signer,
    jwksSource: { async read(): Promise<JwkSet> { return platform.jwks.document() as JwkSet; } },
    envelope: createKmsEnvelopeCipher(config.kmsIdpConnectionKey, platform.kms),
    publisher: {
      async publish(topic, event) { await platform.pubsub.publish(topic, event); },
    },
    revision: 'local',
    automationAppUrl: config.automationAppUrl ?? '',
  };

  if (config.mode === 'token') {
    deps.serviceIdentity = {
      async verify(authorization) {
        const token = authorization?.match(/^Bearer (.+)$/)?.[1];
        return token ? platform.identity.verify(token, config.publicBaseUrl) : null;
      },
    };
    deps.lifecycleServiceAccount = config.lifecycleServiceAccount ?? '';
    deps.provisionerServiceAccount = config.provisionerServiceAccount ?? '';
  }

  const app = createAgentOp(deps);
  return { fetch: (request) => app.fetch(request), kid };
}

export async function startAgentOp(
  platform: LocalPlatform,
  face: 'token' | 'callback',
  loadConfig: (env: NodeJS.ProcessEnv) => AgentOpConfig,
): Promise<Listener> {
  const name = face === 'token' ? 'shared-agent-op' : 'agent-op-callback';
  const app = await createAgentOpApp(platform, loadConfig(agentOpEnvironment(platform, face)));
  return listen({
    name,
    host: platform.config.topology.host,
    port: platform.config.topology.port[name],
    fetch: app.fetch,
  });
}
