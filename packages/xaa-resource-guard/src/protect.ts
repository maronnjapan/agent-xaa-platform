import { AGENT_URN_PREFIX, audienceIncludes } from '@xaa/contracts';
import { createJwksCache, decodeJwsUnverified, verifyCompactJws, verifyCompactJwsRs256, verifyDpopProof, XaaCryptoError, type JtiStore } from '@xaa/crypto';
import type { Context, MiddlewareHandler } from 'hono';

export interface XaaResourceContext {
  humanSubject: string;
  agentId: string;
  scopes: string[];
  isolationLevel: string;
  constraints: Record<string, unknown>;
}

type Env = { Variables: { xaa: XaaResourceContext } };
export interface ResourceProtectionOptions {
  asIssuer: string;
  resourceUri: string;
  jwksUrl: string;
  requiredScopes: (context: Context<Env>) => string[];
  jtiStore: JtiStore;
  iatSkewSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  isRevokedActor?: (actorUrn: string) => Promise<boolean>;
  publicBaseUrl?: string;
}

/**
 * REQ-08-044 asks for a Bearer challenge, RFC 9449 for a DPoP one; both are sent, as
 * two headers rather than one joined value. `error` names the reason in the body — a
 * revoked actor is `token_revoked` (T-RES-22) — while the challenges stay
 * `invalid_token`, which is the only code RFC 6750 defines for this case.
 */
function unauthorized(error: 'invalid_token' | 'token_revoked' = 'invalid_token'): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('WWW-Authenticate', 'DPoP error="invalid_token"');
  headers.append('WWW-Authenticate', 'Bearer error="invalid_token"');
  return new Response(JSON.stringify({ error }), { status: 401, headers });
}

export function createResourceProtection(options: ResourceProtectionOptions): MiddlewareHandler<Env> {
  const jwks = createJwksCache({ url: options.jwksUrl, fetchImpl: options.fetchImpl });
  return async (context, next) => {
    const match = context.req.header('Authorization')?.match(/^DPoP ([^,\s]+)$/);
    if (!match) return unauthorized();
    const accessToken = match[1]!;
    try {
      const decoded = decodeJwsUnverified(accessToken);
      if (typeof decoded.header.kid !== 'string') return unauthorized();
      // The Resource AS signs with RS256 (00b) while every other token on this
      // platform is ES256. The algorithm is read from the header and dispatched to
      // the matching verifier; anything outside these two is rejected outright.
      const publicKey = await jwks.getKey(decoded.header.kid);
      const verified = decoded.header.alg === 'RS256'
        ? await verifyCompactJwsRs256(accessToken, { publicKey, allowedTyp: ['at+jwt'] })
        : await verifyCompactJws(accessToken, { publicKey, allowedTyp: ['at+jwt'] });
      const payload = verified.payload;
      const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
      if (payload.iss !== options.asIssuer || !audienceIncludes(payload.aud, options.resourceUri) || typeof payload.exp !== 'number' || payload.exp < now - 60 || (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now + 60)) || (payload.iat !== undefined && (typeof payload.iat !== 'number' || payload.iat > now + 60))) return unauthorized();
      const act = payload.act;
      const cnf = payload.cnf;
      if (typeof payload.sub !== 'string' || !act || typeof act !== 'object' || typeof (act as Record<string, unknown>).sub !== 'string' || !cnf || typeof cnf !== 'object' || typeof (cnf as Record<string, unknown>).jkt !== 'string') return unauthorized();
      const actorUrn = (act as Record<string, unknown>).sub as string;
      if (!actorUrn.startsWith(AGENT_URN_PREFIX)) return unauthorized();
      if (await options.isRevokedActor?.(actorUrn)) return unauthorized('token_revoked');
      const proof = context.req.header('DPoP');
      if (!proof || proof.includes(',')) return unauthorized();
      const requestUrl = new URL(context.req.path, options.publicBaseUrl ?? options.resourceUri).toString();
      const dpop = await verifyDpopProof(proof, { method: context.req.method, url: requestUrl, accessToken, iatWindowSeconds: options.iatSkewSeconds ?? 60, jtiStore: options.jtiStore });
      if (dpop.jkt !== (cnf as Record<string, unknown>).jkt) return unauthorized();
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
      const required = options.requiredScopes(context);
      if (required.some((scope) => !scopes.some((candidate) => candidate === scope))) return context.json({ error: 'insufficient_scope' }, 403);
      context.set('xaa', {
        humanSubject: payload.sub,
        agentId: actorUrn.slice(AGENT_URN_PREFIX.length),
        scopes,
        isolationLevel: typeof payload.isolation_level === 'string' ? payload.isolation_level : '',
        // `xaa_constraints`, the name the Resource AS mints (T-RES-20). Reading a bare
        // `constraints` here silently made every token-carried limit absent, which is
        // an approval cap that never applies rather than a cap that fails closed.
        constraints: payload.xaa_constraints && typeof payload.xaa_constraints === 'object'
          ? payload.xaa_constraints as Record<string, unknown>
          : {},
      });
      await next();
    } catch (error) {
      if (error instanceof XaaCryptoError) return unauthorized();
      return unauthorized();
    }
  };
}
