import { assertHostAllowed, type HostNotAllowed } from './allowed-hosts.js';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RuntimeHttpClient {
  send(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Every outbound request goes through one place, and that place checks the
 * destination against the frozen allow list before the request is built.
 *
 * There is no retry. A retried token request would replay a DPoP proof and reuse a
 * `jti`, which the other side is right to reject; a retried write could double an
 * approval. Failures come back as failures for the reasoning loop to see.
 */
export function createRuntimeHttpClient(input: {
  allowedHosts: ReadonlySet<string>;
  fetch?: Fetch;
}): RuntimeHttpClient {
  const send: Fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    async send(url, init) {
      assertHostAllowed(input.allowedHosts, url);
      const { timeoutMs, ...rest } = init;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        return await send(url, { ...rest, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type { HostNotAllowed };
