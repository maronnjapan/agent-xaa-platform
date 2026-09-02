import { expect, it } from 'vitest';
import { assertActorTokenClaims, assertActorTokenType, assertAgentId, parseAgentUrn, toAgentUrn } from '../src/index.js';

const agentId = 'agent-0123456789abcdefghjkmnpqrs';
it('normalizes the agent urn', () => {
  expect(toAgentUrn(agentId)).toBe(`urn:xaa:agent:${agentId}`);
  expect(parseAgentUrn(toAgentUrn(agentId))).toBe(agentId);
});
it('rejects a human subject as an agent id', () => {
  expect(() => assertAgentId('user-456')).toThrow();
  expect(() => toAgentUrn('user-456')).toThrow();
});
it('rejects non-jwt actor_token_type', () => {
  for (const type of ['urn:ietf:params:oauth:token-type:access_token', 'urn:ietf:params:oauth:token-type:saml2']) {
    expect(() => assertActorTokenType(type), type).toThrow();
  }
});
it('rejects iss and sub mismatch', () => expect(() => assertActorTokenClaims({ iss: agentId, sub: 'agent-0123456789abcdefghjkmnpqrt', aud: 'a', exp: 2, iat: 1, jti: 'j' })).toThrow());
