import { CAPABILITY_TO_SCOPE, type Capability } from '@xaa/contracts';
import { FirestoreJtiStore, createFirestoreDocumentStore } from '@xaa/gcp';
import createBridge from '@xaa/google-bridge/app';
import { loadConfig } from '@xaa/google-bridge/src/config';
import createStubSaasApi from '@xaa/stub-saas-api/app';
import createStubSaasOp from '@xaa/stub-saas-op/app';
import { createBridgeKms } from '../local/kms.js';
import { listen, type Listener } from '../local/serve.js';
import type { LocalPlatform } from '../platform.js';

export function bridgeEnvironment(platform: LocalPlatform, face: 'internal' | 'callback'): Record<string, string> {
  const { url, endpoints } = platform.config.topology;
  const self = face === 'internal' ? url['google-bridge'] : url['google-bridge-callback'];
  return {
    BRIDGE_FACE: face,
    PUBLIC_BASE_URL: self,
    BRIDGE_INTERNAL_BASE_URL: url['google-bridge'],
    BRIDGE_CALLBACK_BASE_URL: url['google-bridge-callback'],
    AUTOMATION_APP_BASE_URL: url['automation-app'],
    PROVISIONER_BASE_URL: url.provisioner,
    SHARED_ISSUER: endpoints.issuer,
    JWKS_URL: endpoints.jwks_url,
    CONNECTOR_ENCRYPTION_KEY: platform.keys.googleConnector,
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    SAAS_CONNECTOR_MODE: 'stub',
    CALLER_SA_RUNTIME: platform.accounts.agentRuntime!,
    CALLER_SA_SLOTS: '',
    CALLER_SA_PROVISIONER: platform.accounts.provisioner!,
    CALLER_SA_LIFECYCLE: platform.accounts.lifecycle!,
  };
}

/**
 * The OAuth Bridge and the SaaS it is pointed at, both optional.
 *
 * `enable_google_bridge` is false by default on GCP, so it is false by default here:
 * with the Bridge off the seed leaves the bridged catalogue rows out and nothing
 * reaches for it, which is the deployment being reproduced rather than a feature being
 * withheld. Turned on, it runs in `stub` mode against the stub OP and API on their own
 * ports — the same shape `saas_connector_mode = "stub"` gives, and the one that needs no
 * Google OAuth client.
 *
 * Both faces are here for the same reason there are two on GCP: the callback face is
 * the only part a browser reaches and it mounts no route that issues a token.
 */
export function startGoogleBridge(platform: LocalPlatform): Listener[] {
  const { host, port } = platform.config.topology;
  const documents = createFirestoreDocumentStore(platform.firestore, 'google-bridge');
  const kms = createBridgeKms(platform.kms);

  const face = (kind: 'internal' | 'callback') => {
    const config = loadConfig(bridgeEnvironment(platform, kind));
    return createBridge({
      config,
      documents,
      jtiStore: new FirestoreJtiStore(platform.firestore),
      kms,
      // Secret Manager holds these on GCP. There is one connector in stub mode and
      // one secret behind it, and it never leaves this machine.
      readSecret: async () => platform.secrets.stubBridge,
      callerVerify: (token, audience) => platform.identity.verify(token, audience),
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
    });
  };

  const internal = face('internal');
  const callback = face('callback');
  const stubOp = createStubSaasOp();
  const stubApi = createStubSaasApi();

  return [
    listen({ name: 'google-bridge', host, port: port['google-bridge'], fetch: (request) => internal.fetch(request) }),
    listen({ name: 'google-bridge-callback', host, port: port['google-bridge-callback'], fetch: (request) => callback.fetch(request) }),
    listen({ name: 'stub-saas-op', host, port: port['stub-saas-op'], fetch: (request) => stubOp.fetch(request) }),
    listen({ name: 'stub-saas-api', host, port: port['stub-saas-api'], fetch: (request) => stubApi.fetch(request) }),
  ];
}
