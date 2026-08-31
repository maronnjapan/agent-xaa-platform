import type { ClientResolver, TokenClientResolver } from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../oidc/config.js';
import type { HumanIdpEnv } from '../env.js';
import { SCOPE_TO_AUDIENCE } from './audience-map.js';
import { DPOP_REQUIRED_AUDIENCES } from './dpop-required-audiences.js';

export const AUTOMATION_APP_CLIENT_ID = 'automation-app';
export const AGENT_PLATFORM_CLIENT_ID = 'agent-platform';

/**
 * Two confidential clients, no more. RULE-50 / DEC-ID-22: an agent is never a
 * registered client; individual agents are identified by cnf.jkt, act and the audit
 * log. `example-client` from the generator's defaults is deliberately absent.
 */
export function createClientRegistry(env: HumanIdpEnv): ReadonlyMap<string, RegisteredClient> {
  assertRedirectUri(env, env.automationAppRedirectUri);
  assertRedirectUri(env, env.agentOpCallbackUri);

  const registry = new Map<string, RegisteredClient>([
    [AUTOMATION_APP_CLIENT_ID, {
      clientId: AUTOMATION_APP_CLIENT_ID,
      clientSecret: env.clientSecretAutomationApp,
      redirectUris: [env.automationAppRedirectUri],
      clientType: 'confidential',
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      defaultMaxAge: 3600,
    }],
    [AGENT_PLATFORM_CLIENT_ID, {
      clientId: AGENT_PLATFORM_CLIENT_ID,
      clientSecret: env.clientSecretAgentPlatform,
      redirectUris: [env.agentOpCallbackUri],
      clientType: 'confidential',
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      defaultMaxAge: 3600,
    }],
  ]);

  for (const clientId of registry.keys()) {
    if (clientId.startsWith('agent-') && clientId !== AGENT_PLATFORM_CLIENT_ID) {
      throw new Error(`per-agent client registration is forbidden: ${clientId}`);
    }
  }
  assertAudienceTablesAgree();
  return registry;
}

function assertRedirectUri(env: HumanIdpEnv, value: string): void {
  if (env.storeMode === 'gcp' && value.startsWith('http://')) {
    throw new Error('redirect_uri must use https outside local development');
  }
}

/**
 * The DPoP-required list and the scope→audience table are written separately but
 * must describe the same three Control Plane audiences. Drift is a startup failure,
 * not a runtime surprise.
 */
function assertAudienceTablesAgree(): void {
  const mapped = new Set(Object.values(SCOPE_TO_AUDIENCE));
  for (const audience of DPOP_REQUIRED_AUDIENCES) {
    if (!mapped.has(audience)) throw new Error(`DPoP-required audience is unreachable from any scope: ${audience}`);
  }
}

export function createRegistryResolver(registry: ReadonlyMap<string, RegisteredClient>): ClientResolver & TokenClientResolver {
  return { async findClient(clientId: string) { return registry.get(clientId) ?? null; } };
}
