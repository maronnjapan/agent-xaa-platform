import { verifyDpopProof, XaaCryptoError, type JtiStore } from '@xaa/crypto';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlaneVariables } from './types.js';
import { emitProtocolValidation, type ProtocolValidationEmitter } from './protocol-validation.js';

type Env = { Variables: ControlPlaneVariables };
export interface DpopOptions {
  iatSkewSeconds: number;
  jtiStore: JtiStore;
  expectedHtu?: string | ((request: Request) => string);
  protocolValidation?: ProtocolValidationEmitter;
}

function requestHtu(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('X-Forwarded-Proto');
  const host = request.headers.get('Host');
  if (proto) url.protocol = `${proto}:`;
  if (host) url.host = host;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function dpopMiddleware(options: DpopOptions): MiddlewareHandler<Env> {
  return async (context, next) => {
    const proof = context.req.header('DPoP');
    if (!proof || proof.includes(',')) {
      emitProtocolValidation(options.protocolValidation, context, 'invalid_dpop_proof', 'denied', 'invalid_dpop_proof');
      return context.json({ error: 'invalid_dpop_proof' }, 401);
    }
    const authorization = context.req.header('Authorization');
    const token = authorization?.match(/^DPoP (.+)$/)?.[1];
    if (!token) return context.json({ error: 'invalid_token' }, 401);
    try {
      const expected = typeof options.expectedHtu === 'function' ? options.expectedHtu(context.req.raw) : options.expectedHtu ?? requestHtu(context.req.raw);
      const verified = await verifyDpopProof(proof, { method: context.req.method, url: expected, accessToken: token, iatWindowSeconds: options.iatSkewSeconds, jtiStore: options.jtiStore });
      if (verified.jkt !== context.get('accessToken').cnf.jkt) {
        emitProtocolValidation(options.protocolValidation, context, 'dpop_key_binding_mismatch', 'denied', 'dpop_key_binding_mismatch');
        return context.json({ error: 'dpop_key_binding_mismatch' }, 401);
      }
      context.set('dpop', { jti: verified.jti, jkt: verified.jkt });
      await next();
    } catch (error) {
      const code = error instanceof XaaCryptoError && error.code === 'replayed_dpop_proof' ? 'replayed_dpop_proof' : 'invalid_dpop_proof';
      emitProtocolValidation(options.protocolValidation, context, code, 'denied', code);
      return context.json({ error: code }, 401);
    }
  };
}
