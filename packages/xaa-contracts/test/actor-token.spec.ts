import { expect, it } from 'vitest';
import { assertActorTokenClaims, assertActorTokenType, parseAgentUrn, toAgentUrn } from '../src/index.js';

const agentId = 'agent-0123456789abcdefghjkmnpqrs';
it('normalizes the agent urn', () => expect(parseAgentUrn(toAgentUrn(agentId))).toBe(agentId));
it('rejects non-jwt actor_token_type', () => expect(() => assertActorTokenType('urn:ietf:params:oauth:token-type:access_token')).toThrow());
it('rejects iss and sub mismatch', () => expect(() => assertActorTokenClaims({ iss: agentId, sub: 'agent-0123456789abcdefghjkmnpqrt', aud: 'a', exp: 2, iat: 1, jti: 'j' })).toThrow());
