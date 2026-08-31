import { Hono } from 'hono';
import { exportJwks, extractAlgorithmParamsFromJwk, type SigningKey } from '@maronn-openid-connect/core';

export const jwksApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * JWKS Endpoint
 * Serves the public keys used to verify token signatures.
 *
 * T-022: per-purpose key arrays (signingKeys / idTokenSigningKeys / userinfoSigningKeys)
 * are flattened and exposed so rotated-out keys remain verifiable until tokens
 * signed with them expire. kid 指定がある鍵は kid で重複排除し、kid 未指定の
 * 鍵は最新（最後に投入された）1 件のみ採用する。
 */
jwksApp.get('/', async (c) => {
  // 旧 single-key context をフォールバックとして温存することで、createApp 経路や
  // 一部だけ手書きされた route も従来どおり動く。
  const signingKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningKeys = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];

  const candidates: { jwk: JsonWebKey; kid: string | undefined }[] = [];
  const pushAll = (keys: SigningKey[]) => {
    for (const k of keys) {
      candidates.push({ jwk: k.publicJwk as JsonWebKey, kid: k.keyId });
    }
  };
  if (signingKeys.length > 0) {
    pushAll(signingKeys);
  } else {
    const publicJwk = c.get('publicJwk');
    const keyId = c.get('keyId');
    if (publicJwk) {
      candidates.push({ jwk: publicJwk, kid: keyId });
    }
  }
  if (idTokenSigningKeys.length > 0) {
    pushAll(idTokenSigningKeys);
  } else {
    const idTokenPublicJwk = c.get('idTokenPublicJwk');
    const idTokenKeyId = c.get('idTokenKeyId');
    if (idTokenPublicJwk) {
      candidates.push({ jwk: idTokenPublicJwk, kid: idTokenKeyId });
    }
  }
  if (userinfoSigningKeys.length > 0) {
    pushAll(userinfoSigningKeys);
  } else {
    const userinfoPublicJwk = c.get('userinfoPublicJwk');
    const userinfoKeyId = c.get('userinfoKeyId');
    if (userinfoPublicJwk) {
      candidates.push({ jwk: userinfoPublicJwk, kid: userinfoKeyId });
    }
  }

  if (candidates.length === 0) {
    return c.json({ error: 'server_error' }, 500);
  }

  // kid 指定がある鍵は最初に出現したものを採用（重複排除）。
  // kid 未指定の鍵は最後に投入された 1 件のみ採用（最新性を優先）。
  const seenKids = new Set<string>();
  let lastUndefinedIndex = -1;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i]!.kid === undefined) lastUndefinedIndex = i;
  }

  const entries: { publicKey: CryptoKey; keyId?: string }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const { jwk, kid } = candidates[i]!;
    if (kid === undefined) {
      if (i !== lastUndefinedIndex) continue;
    } else {
      if (seenKids.has(kid)) continue;
      seenKids.add(kid);
    }
    const algParams = extractAlgorithmParamsFromJwk(jwk);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algParams,
      true,
      ['verify'],
    );
    entries.push({ publicKey, keyId: kid });
  }

  const jwks = await exportJwks(entries);

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(jwks);
});
