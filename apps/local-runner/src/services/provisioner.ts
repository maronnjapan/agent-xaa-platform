import { publishActivityEvent } from '@xaa/contracts';
import { FirestoreJtiStore, createFirestoreDocumentStore } from '@xaa/gcp';
import { createLogger } from '@xaa/logging';
import createProvisioner, { type ProvisionerAppDeps } from '@xaa/provisioner/app';
import { createAgentOpClient } from '@xaa/provisioner/src/agent/idp-connection';
import { createBridgeClient } from '@xaa/provisioner/src/bridge/connection';
import { createDedicatedResources } from '@xaa/provisioner/src/dedicated';
import { loadConfig } from '@xaa/provisioner/src/runtime';
import { createTransactionStore } from '@xaa/provisioner/src/transaction/store';
import type { LocalRunPlatform } from '../local/cloud-run.js';
import { listen, type Listener } from '../local/serve.js';
import { TOPICS, type LocalPlatform } from '../platform.js';
import { agentRuntimeStaticEnvironment } from './agent-runtime.js';
import { agentOpEnvironment } from './agent-op.js';

/** The name Terraform gives the shared Agent Runtime Job every standard agent runs on. */
export const STANDARD_JOB_NAME = 'agent-runtime-standard';

export function provisionerEnvironment(platform: LocalPlatform, standardJobName: string): Record<string, string> {
  const { url, projectId, region, endpoints, bridgeEnabled } = platform.config.topology;
  const serviceResource = (name: string) => `projects/${projectId}/locations/${region}/services/${name}`;
  return {
    PROJECT_ID: projectId,
    REGION: region,
    ISSUER: endpoints.issuer,
    JWKS_URL: endpoints.jwks_url,
    PROVISIONER_AUDIENCE: 'agent-provisioner',
    PUBLIC_BASE_URL: url.provisioner,
    SHARED_AGENT_OP_URL: url['shared-agent-op'],
    STANDARD_JOB_NAME: standardJobName,
    MAX_FULL_ISOLATION_AGENTS: String(platform.config.topology.maxFullIsolationAgents),
    AGENT_MAX_LIFETIME_SECONDS: String(platform.config.topology.agentMaxLifetimeSeconds),
    ACTIVITY_TOPIC: TOPICS.activity,
    IDJAG_KEY_RING: platform.keys.idJagKeyRing,
    IDP_CONNECTION_KEY_RING: platform.keys.idpConnectionKeyRing,
    JWKS_BUCKET: 'local-jwks',
    PROVISIONER_SA_EMAIL: platform.accounts.provisioner!,
    LIFECYCLE_SA_EMAIL: platform.accounts.lifecycle!,
    AGENT_PLATFORM_CLIENT_SECRET_ID: platform.secrets.agentPlatformSecretId,
    BRIDGE_INTERNAL_URL: bridgeEnabled ? url['google-bridge'] : '',
    ADMIN_PRINCIPALS: platform.config.adminPrincipals.join(','),
    DEDICATED_RUNTIME_INVOKER_SERVICES: JSON.stringify([
      serviceResource('resource-docs-as'),
      serviceResource('resource-finance-as'),
      serviceResource('resource-docs-api'),
      serviceResource('resource-finance-api'),
      ...(bridgeEnabled ? [serviceResource('google-bridge')] : []),
    ]),
    STORE_MODE: 'emulator',
    PUBSUB_MODE: 'inproc',
    SIGNER_MODE: 'local',
  };
}

/**
 * The Agent Provisioner, with a Cloud Run it can really create things in.
 *
 * For a standard agent this service writes Firestore rows and starts a Job Execution;
 * for a `full_isolation` one it additionally builds that agent its own Agent OP, its
 * own signing and encryption keys, its own two service accounts and its own Job. All
 * of that runs here — `createDedicatedResources` is the deployed function, unchanged —
 * against the local Cloud Run in `local/cloud-run.ts`, which starts the Dedicated OP as
 * another listener and hands back the URL the agent will actually dial.
 *
 * `DEDICATED_OP_ENV` and `DEDICATED_RUNTIME_ENV` are built from the same functions that
 * configure the deployed Agent OP and the deployed Runtime Job, so an isolated agent's
 * environment cannot drift from a shared one's.
 */
export function startProvisioner(platform: LocalPlatform, run: LocalRunPlatform): Listener {
  const standardJobName = run.defineJob(STANDARD_JOB_NAME, agentRuntimeStaticEnvironment(platform, 'standard'));
  const env = provisionerEnvironment(platform, standardJobName);
  const config = loadConfig(env);
  const documents = createFirestoreDocumentStore(platform.firestore, 'provisioner');
  const logger = createLogger('provisioner', 'provisioner');
  const identityToken = platform.identity.tokenProviderFor(platform.accounts.provisioner!);
  const agentOp = createAgentOpClient({ baseUrl: config.sharedAgentOpUrl, identityToken });
  const bridgeUrl = env.BRIDGE_INTERNAL_URL;

  const deps: ProvisionerAppDeps = {
    config,
    documents,
    transactions: createTransactionStore(documents, () => Date.now(), {
      revokeIdpConnection: (idpConnectionId) => agentOp.revokeIdpConnection!(idpConnectionId),
    }),
    jobs: run.jobs,
    clock: { now: () => Date.now() },
    jtiStore: new FirestoreJtiStore(platform.firestore),
    logger,
    // The shared publisher, which validates against the canonical schema before it
    // sends. It writes through the transport installed in `platform.ts`.
    publishActivity: publishActivityEvent,
    agentOp,
    ...(bridgeUrl ? { bridge: createBridgeClient({ baseUrl: bridgeUrl, identityToken }) } : {}),
    verifyInternalCaller: (token, audience) => platform.identity.verify(token, audience),
    verifyAdmin: (token, audience) => platform.identity.verify(token, audience),
    createDedicated: (input) => createDedicatedResources({
      admin: run.admin,
      ledger: input.ledger,
      agentId: input.agentId,
      projectId: platform.config.topology.projectId,
      region: platform.config.topology.region,
      signingKeyRing: platform.keys.idJagKeyRing,
      connectionKeyRing: platform.keys.idpConnectionKeyRing,
      imageEnv: dedicatedOpEnvironment(platform),
      runtimeEnv: agentRuntimeStaticEnvironment(platform, 'full_isolation'),
      jwksBucket: 'local-jwks',
      activityTopic: config.activityTopic,
      runtimeInvokerServices: JSON.parse(env.DEDICATED_RUNTIME_INVOKER_SERVICES!) as string[],
      provisionerMember: `serviceAccount:${platform.accounts.provisioner}`,
      agentPlatformClientSecret: platform.secrets.agentPlatformSecretId,
      taskTimeoutSeconds: input.taskTimeoutSeconds,
      // A Dedicated OP here answers `/livez` as soon as its socket is open, so the
      // health poll settles on the first attempt rather than after five seconds.
      sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, Math.min(ms, 100)); }),
    }),
  };

  const app = createProvisioner(deps);
  return listen({
    name: 'provisioner',
    host: platform.config.topology.host,
    port: platform.config.topology.port.provisioner,
    fetch: (request) => app.fetch(request),
  });
}

/**
 * What a Dedicated Agent OP is started with.
 *
 * The shared OP's token-face environment, less the two values `createDedicatedResources`
 * fills in per agent (the two key names) and less `PUBLIC_BASE_URL`, which is not known
 * until the service has an address — the deployed Provisioner leaves it out for exactly
 * that reason and updates the service once Cloud Run has assigned a URL.
 */
export function dedicatedOpEnvironment(platform: LocalPlatform): Record<string, string> {
  const perAgent = ['PUBLIC_BASE_URL', 'KMS_IDJAG_KEY', 'KMS_IDP_CONNECTION_KEY'];
  return Object.fromEntries(
    Object.entries(agentOpEnvironment(platform, 'token')).filter(([name]) => !perAgent.includes(name)),
  );
}
