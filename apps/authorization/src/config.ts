export interface AuthorizationConfig {
  port: number;
  issuer: string;
  jwksUrl: string;
  authzAudience: string;
  authzPublicBaseUrl: string;
  projectId: string;
  region: string;
  storeMode: 'emulator' | 'gcp';
  pubsubMode: 'inproc' | 'gcp';
  vertexMode: 'fake' | 'live';
  vertexModel: string;
  vertexLocation: string;
  dpopIatSkewSeconds: number;
  dpopJtiTtlSeconds: number;
  lifecycleManagerUrl: string;
  activityTopic: string;
  taxonomyVersion: string;
  agentMaxLifetimeSeconds: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment variable: ${key}`);
  return value;
}

/**
 * Only the two DPoP tuning values carry a default. Everything else must be supplied
 * by the deployment, so a missing Terraform output fails at startup rather than
 * silently changing behaviour.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AuthorizationConfig {
  return {
    port: Number(env.PORT ?? 8080),
    issuer: required(env, 'ISSUER'),
    jwksUrl: required(env, 'JWKS_URL'),
    authzAudience: required(env, 'AUTHZ_AUDIENCE'),
    authzPublicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
    projectId: required(env, 'PROJECT_ID'),
    region: required(env, 'REGION'),
    storeMode: env.STORE_MODE === 'gcp' ? 'gcp' : 'emulator',
    pubsubMode: env.PUBSUB_MODE === 'gcp' ? 'gcp' : 'inproc',
    vertexMode: env.VERTEX_MODE === 'live' ? 'live' : 'fake',
    vertexModel: required(env, 'VERTEX_MODEL'),
    vertexLocation: required(env, 'VERTEX_LOCATION'),
    dpopIatSkewSeconds: Number(env.DPOP_IAT_SKEW_SECONDS ?? '60'),
    dpopJtiTtlSeconds: Number(env.DPOP_JTI_TTL_SECONDS ?? '120'),
    lifecycleManagerUrl: required(env, 'LIFECYCLE_MANAGER_URL'),
    activityTopic: required(env, 'ACTIVITY_TOPIC'),
    taxonomyVersion: required(env, 'TAXONOMY_VERSION'),
    agentMaxLifetimeSeconds: Number(required(env, 'AGENT_MAX_LIFETIME_SECONDS')),
  };
}
