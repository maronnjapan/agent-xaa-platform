export interface AutomationAppConfig {
  faultInjectionEnabled?: boolean;
  port: number;
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  authorizationPlatformUrl: string;
  agentProvisionerUrl: string;
  lifecycleManagerUrl: string;
  docsApiUrl: string;
  activityTopic: string;
  defaultAgentLifetimeHours: number;
  vertexModel: string;
  vertexMode: string;
  storeMode: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/** Deployment opt-in exposes fault exercises only on environments configured for them. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomationAppConfig {
  return {
    faultInjectionEnabled: env.ENABLE_FAULT_INJECTION === 'true',
    port: Number(env.PORT ?? 8080),
    issuer: required(env, 'ISSUER'),
    clientId: env.AUTOMATION_APP_CLIENT_ID ?? 'automation-app',
    clientSecret: required(env, 'CLIENT_SECRET_AUTOMATION_APP'),
    publicBaseUrl: required(env, 'PUBLIC_BASE_URL'),
    authorizationPlatformUrl: required(env, 'AUTHORIZATION_PLATFORM_URL'),
    agentProvisionerUrl: required(env, 'AGENT_PROVISIONER_URL'),
    lifecycleManagerUrl: required(env, 'LIFECYCLE_MANAGER_URL'),
    docsApiUrl: required(env, 'DOCS_API_URL'),
    activityTopic: required(env, 'ACTIVITY_TOPIC'),
    defaultAgentLifetimeHours: Number(env.DEFAULT_AGENT_LIFETIME_HOURS ?? 1),
    vertexModel: required(env, 'VERTEX_MODEL'),
    vertexMode: env.VERTEX_MODE ?? 'fake',
    storeMode: env.STORE_MODE ?? 'emulator',
  };
}
