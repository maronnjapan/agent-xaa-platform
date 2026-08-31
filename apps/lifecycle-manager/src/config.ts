export interface LifecycleConfig {
  projectId: string;
  region: string;
  firestoreDatabaseId: string;
  issuer: string;
  selfAudience: string;
  platformEndpointsUri: string;
  agentMaxLifetimeSeconds: number;
  expiringWindowSeconds: number;
  pubsubMode: string;
  storeMode: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** Ten variables. Every service URL comes from endpoints.json, never from here. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LifecycleConfig {
  return {
    projectId: required(env, 'PROJECT_ID'),
    region: required(env, 'REGION'),
    firestoreDatabaseId: env.FIRESTORE_DATABASE_ID ?? 'xaa',
    issuer: required(env, 'ISSUER'),
    selfAudience: env.SELF_AUDIENCE ?? 'lifecycle-manager',
    platformEndpointsUri: required(env, 'PLATFORM_ENDPOINTS_URI'),
    agentMaxLifetimeSeconds: Number(env.AGENT_MAX_LIFETIME_SECONDS ?? 86_400),
    expiringWindowSeconds: Number(env.EXPIRING_WINDOW_SECONDS ?? 60),
    pubsubMode: env.PUBSUB_MODE ?? 'inproc',
    storeMode: env.STORE_MODE ?? 'emulator',
  };
}

export const CLEANUP_REASONS = ['EXPIRED', 'USER_STOP', 'QUARANTINE', 'IDENTITY_DISABLED', 'REPROVISION'] as const;
export type CleanupReason = (typeof CLEANUP_REASONS)[number];

/**
 * The two reasons that mean something went wrong rather than something ended.
 *
 * Only these revoke the upstream SaaS refresh token, because doing so breaks every
 * other agent sharing that connection — acceptable when an identity is compromised,
 * not when an agent simply reached its expiry.
 */
export function isAbnormalReason(reason: CleanupReason): boolean {
  return reason === 'QUARANTINE' || reason === 'IDENTITY_DISABLED';
}

export const CLEANUP_MAX_ATTEMPTS = 5;
export const CLEANUP_LOCK_SECONDS = 300;
export const SWEEP_BATCH_SIZE = 50;
export const SWEEP_ORPHAN_LIMIT = 10;
export const TRANSACTION_TTL_SECONDS = 1800;
