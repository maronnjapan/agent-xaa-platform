import {
  decodeJwsUnverified, importPublicJwk, jwkThumbprint, verifyCompactJws,
  CLIENT_ASSERTION_JTI_TTL_SECONDS, type JtiStore,
} from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE, JWT_TYP, isAgentId } from '@xaa/contracts';
import type { MiddlewareHandler } from 'hono';
import type { AgentRegistrationRepository } from '../store/index.js';
import type { AgentRegistration } from '../store/types.js';

/** Constant regardless of which check failed: the caller learns nothing from it. */
export const CLIENT_AUTH_FAILED = 'Client authentication failed';
const MAX_ASSERTION_LIFETIME_SECONDS = 300;

export interface ClientAssertionOptions {
  issuer: string;
  registrations: AgentRegistrationRepository;
  jtiStore: JtiStore;
  now?: () => number;
}

class ClientAuthError extends Error {}

/**
 * REQ-05-041 / DEC-ID-11. maronn's client-auth covers only client_secret_* and none,
 * so Agent Client Credential authentication is implemented here. This is a private
 * profile, deliberately not OIDC `private_key_jwt`, and is never advertised in a
 * discovery document (DEV-02).
 *
 * Fixed order: shape, typ, dangerous header members, iss/sub, registration lookup,
 * signature, thumbprint, aud, exp, jti.
 */
export function clientAssertionMiddleware(options: ClientAssertionOptions): MiddlewareHandler {
  return async (context, next) => {
    try {
      const form = await context.req.parseBody();
      const assertionType = String(form.client_assertion_type ?? '');
      const assertion = String(form.client_assertion ?? '');
      if (assertionType !== CLIENT_ASSERTION_TYPE || assertion === '') throw new ClientAuthError();

      const decoded = decodeJwsUnverified(assertion);
      if (decoded.header.typ !== JWT_TYP.CLIENT_ASSERTION) throw new ClientAuthError();
      for (const dangerous of ['jku', 'jwk', 'x5u', 'x5c', 'x5t', 'crit']) {
        if (dangerous in decoded.header) throw new ClientAuthError();
      }

      const { iss, sub, aud, exp, iat, jti } = decoded.payload;
      if (typeof iss !== 'string' || iss !== sub || !isAgentId(iss)) throw new ClientAuthError();
      const registration = await options.registrations.find(iss);
      if (!registration) throw new ClientAuthError();

      const publicKey = await importPublicJwk(registration.client_auth.public_jwk);
      await verifyCompactJws(assertion, { publicKey, allowedTyp: [JWT_TYP.CLIENT_ASSERTION] });

      const thumbprint = await jwkThumbprint(registration.client_auth.public_jwk as never);
      if (thumbprint !== registration.client_auth.jwk_thumbprint) throw new ClientAuthError();

      // Exactly the endpoint actually reached; an assertion minted for /xaa/token
      // must not be replayable at /xaa/subject-token.
      const path = new URL(context.req.url).pathname;
      if (aud !== `${options.issuer}${path}`) throw new ClientAuthError();

      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      if (typeof exp !== 'number' || typeof iat !== 'number' || exp <= now || exp - iat > MAX_ASSERTION_LIFETIME_SECONDS) throw new ClientAuthError();
      if (typeof jti !== 'string' || jti === '') throw new ClientAuthError();
      if (!await options.jtiStore.consume('client-assertion', `${iss}:${jti}`, CLIENT_ASSERTION_JTI_TTL_SECONDS)) throw new ClientAuthError();

      context.set('authenticatedAgentId', iss);
      context.set('agentRegistration', registration satisfies AgentRegistration);
      context.set('parsedForm', form);
      await next();
    } catch {
      return context.json({ error: 'invalid_client', error_description: CLIENT_AUTH_FAILED }, 401);
    }
  };
}
