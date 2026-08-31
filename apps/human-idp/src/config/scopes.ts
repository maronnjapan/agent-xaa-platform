/**
 * REQ-05-004 / REQ-02-013. core only checks that `openid` is present, so the
 * registered-scope narrowing lives here.
 *
 * `agent:operate` means "check status of a running agent and add instructions".
 * Stopping an agent is `agent:revoke`; it is deliberately not folded into operate.
 */
export const SUPPORTED_SCOPES = [
  'openid',
  'offline_access',
  'workdef:submit',
  'agent:provision',
  'agent:revoke',
  'agent:operate',
] as const;

export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];

export const OPERATION_SCOPES = ['workdef:submit', 'agent:provision', 'agent:revoke', 'agent:operate'] as const;
export type OperationScope = (typeof OPERATION_SCOPES)[number];

export const CLIENT_ALLOWED_SCOPES: Readonly<Record<string, readonly SupportedScope[]>> = {
  'automation-app': ['openid', 'workdef:submit', 'agent:provision', 'agent:revoke', 'agent:operate'],
  'agent-platform': ['openid', 'offline_access'],
};

export const UNREGISTERED_SCOPE_DESCRIPTION = 'Requested scope is not registered for this client';

export function isOperationScope(scope: string): scope is OperationScope {
  return (OPERATION_SCOPES as readonly string[]).includes(scope);
}

/** Returns the offending scope, or undefined when every requested scope is registered. */
export function findUnregisteredScope(clientId: string, requested: readonly string[]): string | undefined {
  const allowed = CLIENT_ALLOWED_SCOPES[clientId];
  return requested.find((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope) || !allowed?.includes(scope as SupportedScope));
}
