/**
 * The 16 variables Agent OP reads. Nothing else in `src/` touches `process.env`, so
 * the deployment contract is visible in one place (T-OP-01).
 */
export interface AgentOpConfig {
  mode: 'token' | 'callback';
  issuer: string;
  xaaClientId: string;
  googleCloudProject: string;
  firestoreDatabase: string;
  jwksBucket: string;
  jwksObject: string;
  kmsIdjagKey: string;
  kmsIdpConnectionKey: string;
  humanIdpAuthorizeUrl: string;
  humanIdpTokenUrl: string;
  humanIdpRevokeUrl: string;
  agentOpCallbackUrl: string;
  clientSecretAgentPlatform: string;
  idJagLifetimeSeconds: number;
  /**
   * The agent this process is dedicated to, or null for the shared OP. A dedicated
   * OP refuses to issue for any other agent (T-OP-06).
   */
  agentId: string | null;
  signerMode: 'local' | 'kms';
  storeMode: 'emulator' | 'gcp';
  publicBaseUrl: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing environment variable: ${key}`);
  return value;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[]): T {
  const value = required(env, key);
  if (!allowed.includes(value as T)) throw new Error(`invalid ${key}`);
  return value as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentOpConfig {
  const idJagLifetimeSeconds = Number(env.ID_JAG_LIFETIME_SECONDS ?? '300');
  if (!Number.isInteger(idJagLifetimeSeconds) || idJagLifetimeSeconds < 1) throw new Error('invalid ID_JAG_LIFETIME_SECONDS');
  // AGENT_ID is absent on the shared OP and set to the agent's id on a dedicated one.
  const agentId = env.AGENT_ID && env.AGENT_ID !== '-1' ? env.AGENT_ID : null;
  return {
    mode: oneOf(env, 'MODE', ['token', 'callback'] as const),
    issuer: required(env, 'ISSUER'),
    xaaClientId: env.XAA_CLIENT_ID ?? 'agent-platform',
    googleCloudProject: required(env, 'GOOGLE_CLOUD_PROJECT'),
    firestoreDatabase: env.FIRESTORE_DATABASE ?? 'xaa',
    jwksBucket: required(env, 'JWKS_BUCKET'),
    jwksObject: env.JWKS_OBJECT ?? 'jwks.json',
    kmsIdjagKey: required(env, 'KMS_IDJAG_KEY'),
    kmsIdpConnectionKey: required(env, 'KMS_IDP_CONNECTION_KEY'),
    humanIdpAuthorizeUrl: required(env, 'HUMAN_IDP_AUTHORIZE_URL'),
    humanIdpTokenUrl: required(env, 'HUMAN_IDP_TOKEN_URL'),
    humanIdpRevokeUrl: required(env, 'HUMAN_IDP_REVOKE_URL'),
    agentOpCallbackUrl: required(env, 'AGENT_OP_CALLBACK_URL'),
    clientSecretAgentPlatform: required(env, 'CLIENT_SECRET_AGENT_PLATFORM'),
    idJagLifetimeSeconds,
    agentId,
    signerMode: oneOf(env, 'SIGNER_MODE', ['local', 'kms'] as const),
    storeMode: oneOf(env, 'STORE_MODE', ['emulator', 'gcp'] as const),
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
  };
}
