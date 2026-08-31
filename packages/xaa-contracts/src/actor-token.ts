import { TOKEN_TYPE_JWT } from './grant-types.js';
import { JWT_TYP } from './identifiers.js';
import { assertAgentId } from './agent-namespace.js';

export const ACTOR_TOKEN_TYPE = TOKEN_TYPE_JWT;
export const ACTOR_TOKEN_TYP = JWT_TYP.ACTOR_TOKEN;
export const AGENT_URN_PREFIX = 'urn:xaa:agent:';
export const ACTOR_TOKEN_MAX_LIFETIME_SECONDS = 300;

export interface ActorTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
}

export function toAgentUrn(agentId: string): string {
  assertAgentId(agentId);
  return `${AGENT_URN_PREFIX}${agentId}`;
}

export function parseAgentUrn(urn: string): string {
  if (!urn.startsWith(AGENT_URN_PREFIX)) throw new Error('invalid agent urn');
  const value = urn.slice(AGENT_URN_PREFIX.length);
  assertAgentId(value);
  return value;
}

export function assertActorTokenType(value: unknown): void {
  if (value !== ACTOR_TOKEN_TYPE) throw new Error('invalid actor_token_type');
}

export function assertActorTokenClaims(payload: unknown): asserts payload is ActorTokenClaims {
  if (!payload || typeof payload !== 'object') throw new Error('invalid actor token claims');
  const value = payload as Record<string, unknown>;
  for (const key of ['iss', 'sub', 'aud', 'jti']) if (typeof value[key] !== 'string') throw new Error('invalid actor token claims');
  for (const key of ['exp', 'iat']) if (typeof value[key] !== 'number') throw new Error('invalid actor token claims');
  if (value.iss !== value.sub) throw new Error('invalid actor token claims');
  assertAgentId(value.sub as string);
}
