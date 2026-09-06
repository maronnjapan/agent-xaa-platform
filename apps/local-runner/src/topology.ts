import type { PlatformEndpoints } from '@xaa/contracts';

/**
 * Where each service listens when the platform runs on one machine.
 *
 * This file is the local counterpart of `infra/envs/demo/locals-services.tf` and
 * `platform-endpoints.tf`: the same set of services, the same names, the same
 * relationships. What changes is only the address — a loopback port instead of a Cloud
 * Run hostname — because everything above the address is the deployment being
 * reproduced rather than approximated. A service missing from this map is a service the
 * local platform does not have, which is the same statement Terraform makes.
 *
 * The ports are contiguous from 8080 so an operator can read one number and know which
 * service answered, and 8080 is the Automation App because that is the screen a person
 * opens.
 */
export const LOCAL_SERVICE_PORTS = {
  'automation-app': 8080,
  'human-idp': 8081,
  'analysis-console': 8082,
  authorization: 8083,
  provisioner: 8084,
  lifecycle: 8085,
  'shared-agent-op': 8086,
  'agent-op-callback': 8087,
  'security-detection': 8088,
  'resource-docs-as': 8089,
  'resource-docs-api': 8090,
  'resource-finance-as': 8091,
  'resource-finance-api': 8092,
  'stub-saas-op': 8093,
  'stub-saas-api': 8094,
  'google-bridge': 8095,
  'google-bridge-callback': 8096,
  /** Not a service: the platform's aggregate JWK Set and its endpoints document. */
  'platform-config': 8079,
} as const;

export type LocalServiceName = keyof typeof LOCAL_SERVICE_PORTS;

/**
 * The first port a Dedicated Agent OP takes.
 *
 * A `full_isolation` agent gets its own Agent OP, which on GCP is a Cloud Run service
 * the Provisioner creates at provisioning time. Here it is another listener in this
 * process, and it needs an address that no configured service will ever claim — hence
 * a range above every number in the map.
 */
export const DEDICATED_OP_PORT_BASE = 8200;

export interface LocalTopology {
  host: string;
  /** `http://<host>:<port>` for every service above. */
  url: Readonly<Record<LocalServiceName, string>>;
  port: Readonly<Record<LocalServiceName, number>>;
  /** The first port a Dedicated Agent OP may take, after any offset. */
  dedicatedPortBase: number;
  endpoints: PlatformEndpoints;
  bridgeEnabled: boolean;
  agentMaxLifetimeSeconds: number;
  maxFullIsolationAgents: number;
  financeAbsoluteMaxAmount: number;
  vertexModel: string;
  vertexLocation: string;
  projectId: string;
  region: string;
}

export interface TopologyOptions {
  /**
   * The address the browser and every service uses. `127.0.0.1` rather than
   * `localhost`, because a machine that resolves `localhost` to `::1` first would have
   * half the platform listening on IPv4 and calling IPv6.
   */
  host?: string;
  bridgeEnabled?: boolean;
  agentMaxLifetimeSeconds?: number;
  maxFullIsolationAgents?: number;
  financeAbsoluteMaxAmount?: number;
  vertexModel?: string;
  vertexLocation?: string;
  projectId?: string;
  region?: string;
  portOffset?: number;
}

export function createTopology(options: TopologyOptions = {}): LocalTopology {
  const host = options.host ?? '127.0.0.1';
  const offset = options.portOffset ?? 0;
  const port = Object.fromEntries(
    Object.entries(LOCAL_SERVICE_PORTS).map(([name, value]) => [name, value + offset]),
  ) as Record<LocalServiceName, number>;
  const url = Object.fromEntries(
    Object.entries(port).map(([name, value]) => [name, `http://${host}:${value}`]),
  ) as Record<LocalServiceName, string>;
  const bridgeEnabled = options.bridgeEnabled ?? false;
  const agentMaxLifetimeSeconds = options.agentMaxLifetimeSeconds ?? 86_400;

  return {
    host,
    url,
    port,
    dedicatedPortBase: DEDICATED_OP_PORT_BASE + offset,
    bridgeEnabled,
    agentMaxLifetimeSeconds,
    maxFullIsolationAgents: options.maxFullIsolationAgents ?? 5,
    financeAbsoluteMaxAmount: options.financeAbsoluteMaxAmount ?? 1_000_000,
    vertexModel: options.vertexModel ?? 'gemini-2.5-flash',
    vertexLocation: options.vertexLocation ?? 'us-central1',
    projectId: options.projectId ?? 'xaa-local',
    region: options.region ?? 'asia-northeast1',
    endpoints: {
      issuer: url['human-idp'],
      jwks_url: `${url['platform-config']}/jwks.json`,
      xaa_token_url: url['shared-agent-op'],
      xaa_callback_url: url['agent-op-callback'],
      subject_token_url: `${url['shared-agent-op']}/xaa/subject-token`,
      authorization_url: url.authorization,
      provisioner_url: url.provisioner,
      lifecycle_url: url.lifecycle,
      resource_docs_as_issuer: url['resource-docs-as'],
      resource_docs_api_url: url['resource-docs-api'],
      resource_finance_as_issuer: url['resource-finance-as'],
      resource_finance_api_url: url['resource-finance-api'],
      // The same two placeholders Terraform writes when the Bridge is off: the schema
      // wants a URI, so "absent" cannot be an empty string (see resolveEndpoints).
      bridge_internal_url: bridgeEnabled ? url['google-bridge'] : 'https://disabled.invalid',
      stub_saas_op_issuer: bridgeEnabled ? url['stub-saas-op'] : 'https://disabled.invalid',
      agent_max_lifetime_seconds: agentMaxLifetimeSeconds,
      vertex_model: options.vertexModel ?? 'gemini-2.5-flash',
      vertex_location: options.vertexLocation ?? 'us-central1',
      enable_google_bridge: bridgeEnabled,
    },
  };
}
