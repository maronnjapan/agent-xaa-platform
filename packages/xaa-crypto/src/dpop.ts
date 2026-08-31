import { randomUUID } from 'node:crypto';
import { XaaCryptoError } from './errors.js';
import { createLocalEs256Signer } from './local-signer.js';
import { signCompactJws, verifyCompactJws } from './jws.js';
import { importPublicJwk, type Es256KeyPair, type PublicJwkEs256 } from './keys.js';
import { DPOP_JTI_TTL_SECONDS, type JtiStore } from './jti-store.js';
import { sha256Base64Url } from './sha256.js';
import { jwkThumbprint } from './thumbprint.js';

export function normalizeHtu(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new XaaCryptoError('invalid_dpop_proof'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new XaaCryptoError('invalid_dpop_proof');
  url.hash = '';
  url.search = '';
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return url.toString();
}

export async function createDpopProof(input: {
  method: string;
  url: string;
  keyPair: Es256KeyPair;
  accessToken?: string;
  nonce?: string;
  now?: () => number;
}): Promise<string> {
  if (input.accessToken === '') throw new XaaCryptoError('invalid_dpop_proof');
  const payload: Record<string, unknown> = {
    jti: randomUUID(),
    htm: input.method.toUpperCase(),
    htu: normalizeHtu(input.url),
    iat: Math.floor((input.now?.() ?? Date.now()) / 1000),
  };
  if (input.accessToken !== undefined) payload.ath = await sha256Base64Url(input.accessToken);
  if (input.nonce !== undefined) payload.nonce = input.nonce;
  return signCompactJws({
    header: { alg: 'ES256', typ: 'dpop+jwt', jwk: input.keyPair.publicJwk },
    payload,
    signer: createLocalEs256Signer({ privateKey: input.keyPair.privateKey, kid: '' }),
  });
}

export function createDpopProofForResource(input: {
  method: string;
  url: string;
  keyPair: Es256KeyPair;
  accessToken: string;
  nonce?: string;
  now?: () => number;
}): Promise<string> {
  return createDpopProof(input);
}

function invalid(): never { throw new XaaCryptoError('invalid_dpop_proof'); }

export async function verifyDpopProof(proof: string, input: {
  method: string;
  url: string;
  jtiStore: JtiStore;
  accessToken?: string;
  iatWindowSeconds?: number;
  now?: () => number;
}): Promise<{ jkt: string; jti: string; publicJwk: PublicJwkEs256 }> {
  let decoded: ReturnType<typeof importPublicJwk> extends Promise<CryptoKey> ? Awaited<ReturnType<typeof verifyCompactJws>> : never;
  try {
    decoded = await verifyCompactJws(proof, { allowedTyp: ['dpop+jwt'], allowEmbeddedJwk: true });
  } catch {
    return invalid();
  }
  const publicJwk = decoded.header.jwk;
  if (!publicJwk || decoded.header.typ !== 'dpop+jwt') return invalid();
  const { htm, htu, iat, jti, ath } = decoded.payload;
  if (htm !== input.method.toUpperCase()) return invalid();
  if (htu !== normalizeHtu(input.url)) return invalid();
  const now = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const window = input.iatWindowSeconds ?? 60;
  if (typeof iat !== 'number' || iat < now - window || iat > now + window) return invalid();
  if (typeof jti !== 'string' || jti.length === 0) return invalid();
  if (!await input.jtiStore.consume('dpop', jti, Math.max(DPOP_JTI_TTL_SECONDS, window * 2))) {
    throw new XaaCryptoError('replayed_dpop_proof');
  }
  if (input.accessToken !== undefined && (typeof ath !== 'string' || ath !== await sha256Base64Url(input.accessToken))) return invalid();
  return { jkt: await jwkThumbprint(publicJwk), jti, publicJwk };
}
