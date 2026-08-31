export class RedirectGuardError extends Error {
  readonly code = 'redirect_carries_token';
  constructor(readonly reason: string) { super(`redirect_carries_token: ${reason}`); }
}

/**
 * Keys that must never travel in a URL. A browser redirect goes through the address
 * bar, the history, the Referer header and any proxy in between; a credential there is
 * a credential in all of them.
 */
export const FORBIDDEN_REDIRECT_KEYS = [
  'access_token', 'refresh_token', 'id_token', 'client_secret', 'assertion', 'code_verifier',
] as const;

/** Three base64url segments separated by dots — the shape of a compact JWS. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * RULE-23. Checked immediately before a 302 is sent, on every redirect the platform
 * builds.
 *
 * It throws rather than returning a verdict on purpose: a boolean can be ignored at the
 * call site, and the one place this matters is the line just before the response goes
 * out. A caller that forgets to branch on a boolean ships the bug; a caller that
 * forgets to catch an exception ships a 500, which is the safe direction.
 *
 * `code`, `state` and `transaction_id` are allowed — they belong in a URL by design —
 * but their *values* are still checked, because a token smuggled into `code` is still
 * a token in the address bar.
 */
export function assertNoTokenInRedirect(location: string): void {
  let url: URL;
  try { url = new URL(location); } catch { throw new RedirectGuardError('not a URL'); }

  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  for (const parameters of [url.searchParams, new URLSearchParams(fragment)]) {
    for (const [key, value] of parameters) {
      const name = key.toLowerCase();
      if ((FORBIDDEN_REDIRECT_KEYS as readonly string[]).includes(name)) throw new RedirectGuardError(name);
      if (JWT_SHAPE.test(value)) throw new RedirectGuardError(`${name} carries a token-shaped value`);
    }
  }
}
