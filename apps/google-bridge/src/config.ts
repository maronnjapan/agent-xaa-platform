export type BridgeFace = 'internal' | 'callback';

export interface BridgeConfig {
  face: BridgeFace;
  sharedIssuer: string;
  jwksUrl: string;
  bridgeInternalBaseUrl: string;
  bridgeCallbackBaseUrl: string;
  automationAppBaseUrl: string;
  provisionerBaseUrl: string;
  connectorEncryptionKey: string;
  agentMaxLifetimeSeconds: number;
  saasConnectorMode: string;
  callerSaRuntime: string;
  callerSaSlots: string[];
  callerSaProvisioner: string;
  callerSaLifecycle: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/**
 * One codebase, two services.
 *
 * The internal face answers agents and the control plane; the callback face is the only
 * part a browser ever reaches. They are deployed separately so the browser-facing
 * service has no route that issues a token, and BRIDGE_FACE is what decides which
 * routes a process mounts. There is no default: a misconfigured deployment must fail to
 * start rather than quietly expose the wrong half.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const face = env.BRIDGE_FACE;
  if (face !== 'internal' && face !== 'callback') throw new Error('BRIDGE_FACE must be internal or callback');
  return {
    face,
    sharedIssuer: required(env, 'SHARED_ISSUER'),
    jwksUrl: required(env, 'JWKS_URL'),
    bridgeInternalBaseUrl: required(env, 'BRIDGE_INTERNAL_BASE_URL'),
    bridgeCallbackBaseUrl: required(env, 'BRIDGE_CALLBACK_BASE_URL'),
    automationAppBaseUrl: required(env, 'AUTOMATION_APP_BASE_URL'),
    provisionerBaseUrl: required(env, 'PROVISIONER_BASE_URL'),
    connectorEncryptionKey: required(env, 'CONNECTOR_ENCRYPTION_KEY'),
    agentMaxLifetimeSeconds: Number(env.AGENT_MAX_LIFETIME_SECONDS ?? 86_400),
    saasConnectorMode: env.SAAS_CONNECTOR_MODE ?? 'stub',
    callerSaRuntime: env.CALLER_SA_RUNTIME ?? '',
    callerSaSlots: (env.CALLER_SA_SLOTS ?? '').split(',').filter(Boolean),
    callerSaProvisioner: env.CALLER_SA_PROVISIONER ?? '',
    callerSaLifecycle: env.CALLER_SA_LIFECYCLE ?? '',
  };
}
