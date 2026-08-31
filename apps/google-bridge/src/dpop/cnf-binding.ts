import { decodeJwsUnverified, jwkThumbprint, verifyDpopProof, type JtiStore } from '@xaa/crypto';
import { BridgeError } from '../errors.js';

export interface VerifiedIdJag {
  sub: string;
  actSub: string;
  aud: string;
  scope: string;
  resource: string;
  exp: number;
  cnfJkt: string;
  kid: string;
  issuer: string;
}

/**
 * Proof of possession, added on top of the library's ID-JAG verification.
 *
 * maronn's redeem helpers do not look at `cnf`, so without this the Bridge would accept
 * a stolen ID-JAG from anyone who had it. DEC-ID-08's counterpart: an ID-JAG that
 * carries `cnf.jkt` is only usable by the holder of that key, and one that carries no
 * `cnf` is not usable here at all — there is no branch that lets it through.
 *
 * The distinction between a missing proof and a bad one is preserved because the
 * requirement asks for it: a caller that sent nothing is told the grant is wrong, and
 * one that sent something broken is told the proof is.
 */
export async function verifyCnfBinding(input: {
  request: Request;
  verified: VerifiedIdJag;
  jtiStore: JtiStore;
  expectedHtu: string;
  now?: () => number;
}): Promise<void> {
  if (!input.verified.cnfJkt) throw new BridgeError('invalid_grant', 400);
  const proof = input.request.headers.get('DPoP');
  if (!proof) throw new BridgeError('invalid_grant', 400);

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const decoded = decodeJwsUnverified(proof);
    header = decoded.header;
    payload = decoded.payload;
  } catch {
    throw new BridgeError('invalid_dpop_proof', 400);
  }
  // `/token` hands out no Access Token of its own, so there is nothing for `ath` to
  // bind to. A proof that carries one was made for a different request.
  if (payload.ath !== undefined) throw new BridgeError('invalid_dpop_proof', 400);

  try {
    await verifyDpopProof(proof, {
      method: 'POST', url: input.expectedHtu, jtiStore: input.jtiStore,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch {
    throw new BridgeError('invalid_dpop_proof', 400);
  }

  const thumbprint = await jwkThumbprint(header.jwk as never).catch(() => '');
  // Byte equality on the base64url form. Normalising first would accept two spellings
  // of a thumbprint, and RFC 7638 has only one.
  if (thumbprint !== input.verified.cnfJkt) throw new BridgeError('invalid_dpop_proof', 400);
}
