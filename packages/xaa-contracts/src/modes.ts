export interface Modes {
  signer: 'local' | 'kms';
  vertex: 'fake' | 'live';
  pubsub: 'inproc' | 'gcp';
  store: 'emulator' | 'gcp';
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T {
  if (!value || !allowed.includes(value as T)) throw new Error(`invalid or missing ${name}`);
  return value as T;
}

export function readModes(env: NodeJS.ProcessEnv): Modes {
  const modes: Modes = {
    signer: oneOf('SIGNER_MODE', env.SIGNER_MODE, ['local', 'kms']),
    vertex: oneOf('VERTEX_MODE', env.VERTEX_MODE, ['fake', 'live']),
    pubsub: oneOf('PUBSUB_MODE', env.PUBSUB_MODE, ['inproc', 'gcp']),
    store: oneOf('STORE_MODE', env.STORE_MODE, ['emulator', 'gcp']),
  };
  if (env.NODE_ENV === 'production' && (modes.signer !== 'kms' || modes.pubsub !== 'gcp' || modes.store !== 'gcp')) throw new Error('non-production mode is forbidden');
  return modes;
}

export interface CommonEnvironment {
  issuer: string;
  publicBaseUrl: string;
  platformEndpointsUri: string;
  kidPrefix: string;
  agentMaxLifetimeSeconds: number;
  idJagLifetimeSeconds: number;
}

export function readCommonEnvironment(env: NodeJS.ProcessEnv): CommonEnvironment {
  for (const key of ['ISSUER', 'PUBLIC_BASE_URL', 'PLATFORM_ENDPOINTS_URI', 'KID_PREFIX', 'AGENT_MAX_LIFETIME_SECONDS']) if (!env[key]) throw new Error(`missing ${key}`);
  const agentMaxLifetimeSeconds = Number(env.AGENT_MAX_LIFETIME_SECONDS);
  const idJagLifetimeSeconds = Number(env.ID_JAG_LIFETIME_SECONDS ?? '300');
  if (!Number.isInteger(agentMaxLifetimeSeconds) || agentMaxLifetimeSeconds < 1 || !Number.isInteger(idJagLifetimeSeconds) || idJagLifetimeSeconds < 1) throw new Error('invalid lifetime');
  new URL(env.ISSUER!); new URL(env.PUBLIC_BASE_URL!);
  if (!env.PLATFORM_ENDPOINTS_URI!.startsWith('gs://')) throw new Error('invalid PLATFORM_ENDPOINTS_URI');
  return { issuer: env.ISSUER!, publicBaseUrl: env.PUBLIC_BASE_URL!, platformEndpointsUri: env.PLATFORM_ENDPOINTS_URI!, kidPrefix: env.KID_PREFIX!, agentMaxLifetimeSeconds, idJagLifetimeSeconds };
}
