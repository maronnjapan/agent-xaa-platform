import { createDpopProof } from '@xaa/crypto';
import type { DpopKey } from '../context/execution-context.js';

/**
 * A token that came from a Resource AS or the Bridge, and nothing else.
 *
 * The brand is the point: only the two response parsers can produce this type, so a
 * Service Account ID Token — or any other string that happens to be a credential —
 * cannot be handed to the resource request builder. REQ-01-015 says an agent reaches
 * a resource as the delegated human, never as the platform's own identity; a `string`
 * parameter would have left that to review.
 */
export type ResourceAccessToken = string & { readonly __brand: 'resource-access-token' };

/** Called only by redeem-id-jag and redeem-via-bridge, on a value they just received. */
export function asResourceAccessToken(value: string, source: 'resource-as' | 'bridge'): ResourceAccessToken {
  if (source !== 'resource-as' && source !== 'bridge') throw new Error('unknown access token source');
  return value as ResourceAccessToken;
}

/**
 * `ath` is not optional here. A resource request carries an Access Token, and RFC 9449
 * binds the proof to it by hash; omitting `ath` would leave a proof that any holder of
 * a leaked token could pair with.
 */
export async function buildResourceAuthorization(
  token: ResourceAccessToken,
  request: { method: string; url: string },
  key: DpopKey,
  now?: () => number,
): Promise<{ Authorization: string; DPoP: string }> {
  const proof = await createDpopProof({
    method: request.method,
    url: request.url,
    keyPair: key,
    accessToken: token,
    ...(now ? { now } : {}),
  });
  return { Authorization: `DPoP ${token}`, DPoP: proof };
}
