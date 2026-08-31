import { verifyDpopProof, XaaCryptoError, type JtiStore } from '@xaa/crypto';
import type { MiddlewareHandler } from 'hono';
import { recordDpopViolation } from '../validation/dpop-violations.js';

export interface DpopMiddlewareOptions {
  /**
   * The URL the request actually arrived at. Under the `direct` issuer profile Agent
   * OP runs on a different host from the issuer, so building `htu` from the issuer
   * would never match (DEC-ID-04).
   */
  publicBaseUrl: string;
  jtiStore: JtiStore;
  now?: () => number;
}

/**
 * REQ-05-074. A proof is mandatory on both token endpoints; there is no flag that
 * makes it optional. Verification order is fixed in packages/xaa-crypto and is not
 * reordered here (DEC-ID-12).
 */
export function dpopMiddleware(options: DpopMiddlewareOptions): MiddlewareHandler {
  return async (context, next) => {
    const header = context.req.header('DPoP');
    const path = new URL(context.req.url).pathname;
    if (!header) {
      recordDpopViolation(context, 'invalid_dpop_proof', path);
      return context.json({ error: 'invalid_dpop_proof' }, 400);
    }
    const proofs = header.split(',').map((value) => value.trim()).filter(Boolean);
    if (proofs.length !== 1) {
      recordDpopViolation(context, 'invalid_dpop_proof', path);
      return context.json({ error: 'invalid_dpop_proof' }, 400);
    }
    try {
      const verified = await verifyDpopProof(proofs[0]!, {
        method: 'POST',
        url: `${options.publicBaseUrl}${path}`,
        jtiStore: options.jtiStore,
        ...(options.now ? { now: options.now } : {}),
      });
      // No Access Token is presented at these endpoints, so a proof carrying `ath`
      // was minted for a different hop and is rejected rather than ignored.
      if (typeof verified.publicJwk === 'object' && proofCarriesAth(proofs[0]!)) {
        recordDpopViolation(context, 'invalid_dpop_proof', path);
        return context.json({ error: 'invalid_dpop_proof' }, 400);
      }
      context.set('dpopJkt', verified.jkt);
      context.set('dpopJti', verified.jti);
      await next();
      return;
    } catch (error) {
      const code = error instanceof XaaCryptoError && error.code === 'replayed_dpop_proof'
        ? 'replayed_dpop_proof' : 'invalid_dpop_proof';
      recordDpopViolation(context, code, path);
      return context.json({ error: 'invalid_dpop_proof' }, 400);
    }
  };
}

function proofCarriesAth(proof: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return payload.ath !== undefined;
  } catch {
    return false;
  }
}
