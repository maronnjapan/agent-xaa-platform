import type { JwkSet } from './verify.js';
import { allowedHostsFor, createBridgeFetch, type Send } from '../http/outbound.js';

export const JWKS_TTL_MS = 300_000;

export class JwksUnavailable extends Error {
  readonly code = 'jwks_unavailable';
}

/**
 * The shared key set, fetched from configuration and cached for five minutes.
 *
 * On a fetch failure the last good copy is used: keys rotate rarely, and refusing every
 * token because a bucket was briefly unreachable would be a worse outage than serving
 * from a slightly stale set. With no copy at all there is nothing to fall back to, and
 * the caller gets a 503 rather than a verification that cannot be trusted.
 */
export function createJwksCache(input: {
  url: string;
  fetchImpl?: Send;
  now?: () => number;
}): { get(): Promise<JwkSet>; fetches(): number } {
  // Through the same wrapper as every other outbound call: the JWKS host is on the
  // allow list precisely so this one does not need an exemption.
  const bridgeFetch = createBridgeFetch(input.fetchImpl);
  const allowed = allowedHostsFor({ jwksUrl: input.url });
  const send = (url: string, init: RequestInit) => bridgeFetch(url, init, allowed);
  const now = input.now ?? (() => Date.now());
  let cached: { value: JwkSet; readAt: number } | undefined;
  let fetches = 0;

  return {
    fetches: () => fetches,
    async get() {
      if (cached && now() - cached.readAt < JWKS_TTL_MS) return cached.value;
      try {
        fetches += 1;
        const response = await send(input.url, {});
        if (!response.ok) throw new Error('jwks fetch failed');
        const value = await response.json() as JwkSet;
        cached = { value, readAt: now() };
        return value;
      } catch (error) {
        if (cached) return cached.value;
        throw new JwksUnavailable((error as Error).message);
      }
    },
  };
}
