import { jwkThumbprint, verifyDpopProof, XaaCryptoError, type JtiStore } from '@xaa/crypto';
import { requiresDpop } from '../config/dpop-required-audiences.js';

export type DpopStatus = 'valid' | 'invalid' | 'absent' | 'not_applicable';

export interface DpopBindingResult {
  status: DpopStatus;
  /** RFC 7638 thumbprint of the proof key, present only when status is 'valid'. */
  jkt?: string;
}

export class DpopBindingError extends Error {
  constructor(readonly code: 'invalid_dpop_proof') {
    super('invalid_dpop_proof');
    this.name = 'DpopBindingError';
  }
}

export interface DpopBindingOptions {
  /** Raw DPoP header values seen on the request; more than one is a protocol error. */
  proofs: string[];
  issuer: string;
  jtiStore: JtiStore;
  /** The audience the resulting Access Token will carry. */
  audience: unknown;
  /** DPOP_REQUIRED acts on top of the three Control Plane audiences. */
  alwaysRequired: boolean;
  now?: () => number;
}

/**
 * REQ-05-018 / REQ-02-014. Verifies the proof presented at /token and returns the
 * `cnf.jkt` to bind into the Access Token.
 *
 * `ath` is not required here: at /token the client has not yet been given an Access
 * Token, so there is nothing to hash. Every later hop does require it (DEC-ID-12).
 */
export async function bindDpop(options: DpopBindingOptions): Promise<DpopBindingResult> {
  const required = options.alwaysRequired || requiresDpop(options.audience);
  if (options.proofs.length === 0) {
    if (required) throw new DpopBindingError('invalid_dpop_proof');
    return { status: 'absent' };
  }
  if (options.proofs.length > 1) throw new DpopBindingError('invalid_dpop_proof');
  try {
    const verified = await verifyDpopProof(options.proofs[0]!, {
      method: 'POST',
      url: `${options.issuer}/token`,
      jtiStore: options.jtiStore,
      ...(options.now ? { now: options.now } : {}),
    });
    return { status: 'valid', jkt: verified.jkt };
  } catch (error) {
    if (error instanceof XaaCryptoError) throw new DpopBindingError('invalid_dpop_proof');
    throw error;
  }
}

export { jwkThumbprint };
