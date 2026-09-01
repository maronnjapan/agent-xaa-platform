import { assertHostAllowed, type HostNotAllowed } from './allowed-hosts.js';
import { invokerAuthorizationHeader, type InvokerIdToken } from './internal-invoker-token.js';

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
  /**
   * The platform services that sit behind Cloud Run's own IAM check: the Agent OP and
   * the Bridge. A request to one of them carries the Execution's `run.invoker` token
   * beside its own Authorization header, because without it Cloud Run refuses the call
   * before the app ever sees the agent's credentials.
   */
  internalOrigins?: ReadonlySet<string>;
  invokerToken?: (audience: string) => Promise<InvokerIdToken | undefined>;
}): RuntimeHttpClient {
  const send: Fetch = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  return {
    async send(url, init) {
      assertHostAllowed(input.allowedHosts, url);
      const origin = new URL(url).origin;
      const invoker = input.invokerToken && input.internalOrigins?.has(origin)
        ? await input.invokerToken(origin)
        : undefined;
      if (invoker) {
        init = { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...invokerAuthorizationHeader(invoker) } };
      }
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
