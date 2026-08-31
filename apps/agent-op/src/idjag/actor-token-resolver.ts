import {
  IdJagError, TOKEN_TYPE_JWT,
  type IdJagActor, type IdJagActorTokenResolver, type IdJagActorTokenResolverInput,
} from '@maronn-openid-connect/experimental/id-jag';
import { decodeJwsUnverified, importPublicJwk, verifyCompactJws } from '@xaa/crypto';
import { ACTOR_TOKEN_TYP, isAgentId, toAgentUrn } from '@xaa/contracts';
import type { AgentRegistration } from '../store/types.js';

/**
 * REQ-05-069 / REQ-05-044. The actor_token is the agent's own assertion, signed with
 * the key recorded in its registration — not an ID Token this OP issued. That is why
 * `input.jwks` and `input.issuer` are deliberately unused: resolving it against the
 * shared JWK Set would let any key in that set impersonate any agent.
 *
 * Returning null makes the library answer invalid_request. The one case that must be
 * invalid_grant — an actor that belongs to a different agent than the one that
 * authenticated — throws instead.
 */
export function createActorTokenResolver(options: {
  authenticatedAgentId: string;
  registration: AgentRegistration;
}): IdJagActorTokenResolver {
  return async (input: IdJagActorTokenResolverInput): Promise<IdJagActor | null> => {
    if (input.actorTokenType !== TOKEN_TYPE_JWT) return null;

    let decoded;
    try { decoded = decodeJwsUnverified(input.actorToken); } catch { return null; }
    if (decoded.header.typ !== ACTOR_TOKEN_TYP || decoded.header.alg !== 'ES256') return null;
    for (const dangerous of ['jku', 'jwk', 'x5u', 'x5c']) if (dangerous in decoded.header) return null;

    const { iss, sub } = decoded.payload;
    if (typeof iss !== 'string' || iss !== sub || !isAgentId(iss)) return null;
    if (iss !== options.authenticatedAgentId) {
      throw new IdJagError('invalid_grant', 'The provided actor_token is not valid');
    }

    try {
      const publicKey = await importPublicJwk(options.registration.client_auth.public_jwk);
      await verifyCompactJws(input.actorToken, { publicKey, allowedTyp: [ACTOR_TOKEN_TYP] });
    } catch {
      return null;
    }
    // act.sub is namespaced, never the bare agent id (DEC-ID-10).
    return { sub: toAgentUrn(iss) };
  };
}
