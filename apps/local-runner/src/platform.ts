import { setActivityTransport, ACTIVITY_TOPIC } from '@xaa/contracts';
import { createFirestoreDouble, type Firestore } from '@xaa/gcp';
import { assertLogEntry, setLogSink } from '@xaa/logging';
import { createModelClient, setDefaultModelClient, type VertexClient } from '@xaa/vertex';
import type { LocalRunnerConfig } from './config.js';
import { createLocalJwks, type LocalJwks } from './local/jwks.js';
import { createLocalKms, type LocalKmsClient } from './local/kms.js';
import { createLocalPubSub, type LocalPubSub } from './local/pubsub.js';
import { createLocalServiceIdentity, serviceAccounts, type LocalServiceIdentity } from './local/service-identity.js';

/** The three topics `infra/envs/demo` declares, named as it names them. */
export const TOPICS = {
  activity: ACTIVITY_TOPIC,
  permissionChanged: 'human-permission-changed',
  securityLogs: 'security-logs',
  identityDisabled: 'human-identity-disabled',
} as const;

export interface LocalPlatform {
  config: LocalRunnerConfig;
  firestore: Firestore;
  jwks: LocalJwks;
  kms: LocalKmsClient;
  pubsub: LocalPubSub;
  identity: LocalServiceIdentity;
  accounts: Readonly<Record<string, string>>;
  model: VertexClient;
  /** The KMS resource names Terraform creates once, shared by every service. */
  keys: {
    humanIdpSso: string;
    sharedAgentOpIdJag: string;
    idpConnection: string;
    resourceDocsAs: string;
    resourceFinanceAs: string;
    googleConnector: string;
    idJagKeyRing: string;
    idpConnectionKeyRing: string;
  };
  /** Client secrets. Secret Manager holds these on GCP; here they are generated. */
  secrets: {
    automationApp: string;
    agentPlatform: string;
    analysisConsole: string;
    agentPlatformSecretId: string;
    stubBridge: string;
  };
  shutdown(): Promise<void>;
}

/**
 * Everything the platform needs that is not one of its own services.
 *
 * On GCP these are seven Google products. Here each is a small object with the same
 * surface, built once and shared by every service in the process — which is what makes
 * the local platform one platform rather than sixteen isolated apps: one Firestore, so
 * the Provisioner's write is the Agent OP's read; one Pub/Sub, so an event published by
 * the Runtime reaches the timeline; one JWK Set, so a Resource Server verifies a grant
 * the Agent OP signed.
 */
export async function createLocalPlatform(config: LocalRunnerConfig, overrides: { model?: VertexClient } = {}): Promise<LocalPlatform> {
  const { projectId, region } = config.topology;
  const ring = (name: string) => `projects/${projectId}/locations/${region}/keyRings/${name}`;

  const platform: LocalPlatform = {
    config,
    firestore: createFirestoreDouble(),
    jwks: createLocalJwks(),
    kms: createLocalKms(),
    pubsub: createLocalPubSub({
      onError: (topic, error) => {
        process.stderr.write(`[local] delivery on ${topic} failed: ${(error as Error).message}\n`);
      },
    }),
    identity: await createLocalServiceIdentity(),
    accounts: serviceAccounts(projectId),
    model: overrides.model ?? createModelClient(config.model),
    keys: {
      humanIdpSso: `${ring('sso-signing')}/cryptoKeys/human-idp-sso`,
      sharedAgentOpIdJag: `${ring('idjag-signing')}/cryptoKeys/shared-agent-op/cryptoKeyVersions/1`,
      idpConnection: `${ring('idp-connection-encryption')}/cryptoKeys/idp-connection`,
      resourceDocsAs: `${ring('resource-as-signing')}/cryptoKeys/resource-docs-as`,
      resourceFinanceAs: `${ring('resource-as-signing')}/cryptoKeys/resource-finance-as`,
      googleConnector: `${ring('connector-encryption')}/cryptoKeys/google-connector`,
      idJagKeyRing: ring('idjag-signing'),
      idpConnectionKeyRing: ring('idp-connection-encryption'),
    },
    secrets: {
      // Fixed rather than random: a client secret shared between two services in one
      // process has to be the same string on both sides, and it never leaves the
      // machine. What matters for parity is that the Human IdP checks it at all.
      automationApp: 'local-automation-app-secret',
      agentPlatform: 'local-agent-platform-secret',
      analysisConsole: 'local-analysis-console-secret',
      agentPlatformSecretId: `projects/${projectId}/secrets/human-idp-agent-platform-client-secret`,
      stubBridge: 'local-stub-bridge-secret',
    },
    async shutdown() {
      setLogSink(undefined);
      setActivityTransport(undefined);
      setDefaultModelClient(undefined);
    },
  };

  // Every application that reaches for a model through `generateJson` gets this one,
  // so the provider is chosen once, here, rather than by whichever service asks first.
  setDefaultModelClient(platform.model);
  // The Activity stream has a transport that is not Pub/Sub's, and every publisher in
  // the process writes through it (RULE-55: one topic, one name, everywhere).
  setActivityTransport(platform.pubsub);

  return platform;
}

/**
 * Cloud Logging's Log Sink, as a function.
 *
 * On GCP every line an application writes to stdout is picked up by Cloud Logging and
 * forwarded to the `security-logs` topic, which Security Detection pulls. Here the
 * shared logger's sink does both halves: the line still goes to stdout, where an
 * operator reads it, and the parsed entry goes to the same topic the detector reads.
 * The filter matches the sink's: entries carrying a `log_source`, and nothing else.
 */
export function installLogSink(platform: LocalPlatform): void {
  setLogSink((line) => {
    if (!platform.config.quiet) process.stdout.write(line);
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { return; }
    try { assertLogEntry(entry); } catch { return; }
    void platform.pubsub.publish(TOPICS.securityLogs, entry);
  });
}
