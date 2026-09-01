export interface AutomationAppConfig {
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

/**
 * Fourteen variables and no more.
 *
 * Twelve are the original list; `CLIENT_SECRET_AUTOMATION_APP` and `PUBLIC_BASE_URL`
 * joined them when the login flow became real, because the OIDC code exchange cannot be
 * made without a client secret and a redirect URI that matches the one the Human IdP was
 * given.
 *
 * The list stays short because of what is missing from it: there is no Capability
 * Taxonomy URL, no resource list and no isolation threshold. Automation App is the
 * screen a person uses; the decisions belong to the Authorization Platform (RULE-07),
 * and giving this app a way to read the vocabulary is how that boundary erodes.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomationAppConfig {
  return {
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
