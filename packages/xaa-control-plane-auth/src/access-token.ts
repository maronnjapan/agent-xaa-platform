import { audienceIncludes } from '@xaa/contracts';
import { createJwksCache, decodeJwsUnverified, verifyCompactJws, verifyCompactJwsRs256 } from '@xaa/crypto';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlaneVariables, VerifiedAccessToken } from './types.js';
import { emitProtocolValidation, type ProtocolValidationEmitter } from './protocol-validation.js';

type Env = { Variables: ControlPlaneVariables };
export interface AccessTokenOptions {
  issuer: string;
  jwksUrl: string;
  audience: string;
  requiredScope: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  protocolValidation?: ProtocolValidationEmitter;
}

function fail(code: string, status: 401 | 403): Response {
  return Response.json({ error: code }, { status, headers: status === 401 ? { 'WWW-Authenticate': 'DPoP error="invalid_token"' } : undefined });
}

export function accessTokenMiddleware(options: AccessTokenOptions): MiddlewareHandler<Env> {
  const jwks = createJwksCache({ url: options.jwksUrl, fetchImpl: options.fetchImpl });
  return async (context, next) => {
    const authorization = context.req.header('Authorization');
    const match = authorization?.match(/^DPoP ([^,\s]+)$/);
    if (!match) {
      emitProtocolValidation(options.protocolValidation, context, 'invalid_signature', 'denied', 'invalid_token');
      return fail('invalid_token', 401);
    }
    try {
      const token = match[1]!;
      const unverified = decodeJwsUnverified(token);
      if (typeof unverified.header.kid !== 'string') throw new Error('invalid token');
      // Human IdP signs with RS256 because core's discovery builder requires an
      // RS256 key; everything else on the platform is ES256. The header chooses the
      // verifier, and any other alg falls through to invalid_token.
      const publicKey = await jwks.getKey(unverified.header.kid);
      const verified = unverified.header.alg === 'RS256'
        ? await verifyCompactJwsRs256(token, { publicKey, allowedTyp: ['at+jwt'] })
        : await verifyCompactJws(token, { publicKey, allowedTyp: ['at+jwt'] });
      const payload = verified.payload;
      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      if (payload.iss !== options.issuer || typeof payload.exp !== 'number' || payload.exp < now - 60 || (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now + 60)) || payload.nonce !== undefined || payload.at_hash !== undefined) throw new Error('invalid token');
      if (!audienceIncludes(payload.aud, options.audience)) {
        emitProtocolValidation(options.protocolValidation, context, 'audience_mismatch', 'denied', 'invalid_audience');
        return fail('invalid_audience', 401);
      }
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
      if (!scopes.some((scope) => scope === options.requiredScope)) {
        emitProtocolValidation(options.protocolValidation, context, 'invalid_scope', 'denied', 'insufficient_scope');
        return fail('insufficient_scope', 403);
      }
      const cnf = payload.cnf;
      if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || !cnf || typeof cnf !== 'object' || typeof (cnf as Record<string, unknown>).jkt !== 'string' || !(typeof payload.aud === 'string' || Array.isArray(payload.aud))) throw new Error('invalid token');
      const claims: VerifiedAccessToken = { sub: payload.sub, aud: payload.aud as string | string[], scope: scopes, cnf: { jkt: (cnf as Record<string, unknown>).jkt as string }, jti: payload.jti };
      context.set('accessToken', claims);
      await next();
    } catch {
      emitProtocolValidation(options.protocolValidation, context, 'invalid_signature', 'denied', 'invalid_token');
      return fail('invalid_token', 401);
    }
  };
}
