import { OPERATION_SCOPES, isOperationScope, type OperationScope } from './scopes.js';

/**
 * REQ-02-011 read through DEV-12. One operation scope maps to exactly one audience.
 * The five audiences the design calls for come from two sources: the two ID Token
 * audiences are client ids, and these three are the Access Token audiences.
 */
export const SCOPE_TO_AUDIENCE: Readonly<Record<OperationScope, string>> = {
  'workdef:submit': 'authorization-platform',
  'agent:provision': 'agent-provisioner',
  'agent:revoke': 'lifecycle-manager',
  'agent:operate': 'automation-app',
};

export type AudienceDecision =
  | { outcome: 'none' }
  | { outcome: 'audience'; audience: string }
  | { outcome: 'error'; error: 'invalid_scope' | 'invalid_target' };

/**
 * Fixed decision order (T-IDP-11):
 * 1. take the operation scopes out of the request
 * 2. map them to audiences
 * 3. more than one distinct audience is invalid_scope
 * 4. no `audience` parameter -> use the mapped one
 * 5. an `audience` parameter that does not match byte for byte is invalid_target
 */
export function decideAudience(requestedScopes: readonly string[], audienceParameter: string[] | undefined): AudienceDecision {
  const mapped = [...new Set(requestedScopes.filter(isOperationScope).map((scope) => SCOPE_TO_AUDIENCE[scope]))];
  if (mapped.length > 1) return { outcome: 'error', error: 'invalid_scope' };
  if (mapped.length === 0) {
    return audienceParameter === undefined ? { outcome: 'none' } : { outcome: 'error', error: 'invalid_target' };
  }
  const audience = mapped[0]!;
  if (audienceParameter === undefined) return { outcome: 'audience', audience };
  if (audienceParameter.length !== 1 || audienceParameter[0] !== audience) return { outcome: 'error', error: 'invalid_target' };
  return { outcome: 'audience', audience };
}

export const OPERATION_SCOPE_LIST = OPERATION_SCOPES;
