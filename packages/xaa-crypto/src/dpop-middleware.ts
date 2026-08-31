import type { Context, MiddlewareHandler } from 'hono';
import { XaaCryptoError } from './errors.js';
import { verifyDpopProof } from './dpop.js';
import type { JtiStore } from './jti-store.js';

type DpopEnv = {
  Bindings: { PUBLIC_BASE_URL?: string };
  Variables: { protocolViolationCode: string; dpop: { jkt: string; jti: string } };
};

function fail(c: Context<DpopEnv>, status: 400 | 401, code: string, authenticate = false): Response {
  c.set('protocolViolationCode', code);
  if (authenticate) c.header('WWW-Authenticate', `DPoP error="${code === 'invalid_token' ? code : 'invalid_token'}"`);
  return c.json({ error: code }, status);
}

export function createDpopMiddleware(options: {
  jtiStore: JtiStore;
  requireAccessToken: boolean;
  resolveBoundJkt?: (accessToken: string) => Promise<string | undefined>;
  iatWindowSeconds?: number;
  publicBaseUrl?: string;
}): MiddlewareHandler<DpopEnv> {
  return async (c, next) => {
    const authorization = c.req.header('Authorization');
    const match = authorization?.match(/^DPoP (.+)$/);
    if (options.requireAccessToken && !match) return fail(c, 401, 'invalid_token', true);
    const accessToken = match?.[1];
    const proof = c.req.header('DPoP');
    if (!proof || proof.includes(',')) return fail(c, 400, 'invalid_dpop_proof');
    const base = options.publicBaseUrl ?? c.env?.PUBLIC_BASE_URL;
    if (!base) return fail(c, 400, 'invalid_dpop_proof');
    const url = new URL(c.req.path, base).toString();
    try {
      const result = await verifyDpopProof(proof, {
        method: c.req.method,
        url,
        jtiStore: options.jtiStore,
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(options.iatWindowSeconds === undefined ? {} : { iatWindowSeconds: options.iatWindowSeconds }),
      });
      if (options.requireAccessToken) {
        if (!accessToken || !options.resolveBoundJkt) return fail(c, 401, 'dpop_key_binding_mismatch', true);
        const bound = await options.resolveBoundJkt(accessToken);
        if (!bound || bound !== result.jkt) return fail(c, 401, 'dpop_key_binding_mismatch', true);
      }
      c.set('dpop', { jkt: result.jkt, jti: result.jti });
      await next();
    } catch (error) {
      const code = error instanceof XaaCryptoError ? error.code : 'invalid_dpop_proof';
      return fail(c, code === 'dpop_key_binding_mismatch' ? 401 : 400, code, code === 'dpop_key_binding_mismatch');
    }
  };
}
