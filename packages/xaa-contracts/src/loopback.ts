/**
 * The addresses that are, by construction, this machine and nothing else.
 *
 * Only literals. A name that merely *resolves* to a loopback address is not one of
 * these — resolution can change between the check and the connection, which is the
 * whole reason `assertHostAllowed` compares host names rather than addresses.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Whether a URL is one the platform is willing to treat as a secure origin.
 *
 * Every URL in a deployment is `https`, and the rules that say so are load-bearing:
 * RFC 8707 wants a resource identifier to be an absolute https URI, and the Bridge
 * must not send a token over a channel anyone can read. Neither rule is about the
 * scheme for its own sake — both are about the network between here and there.
 *
 * A loopback address has no such network. `http://127.0.0.1:8090` cannot be observed
 * from another host, cannot be reached from another host, and cannot be pointed
 * somewhere else by DNS; the same reasoning is why RFC 8252 §7.3 makes exactly this
 * exception for a native app's redirect, and why this repository already makes it for
 * the Human IdP's registered redirect URIs. It exists so the platform can run on one
 * machine with no certificate authority, and it widens nothing in a deployment: no
 * Cloud Run URL is a loopback literal.
 */
export function isSecureOrLoopback(value: string | URL): boolean {
  let url: URL;
  try { url = value instanceof URL ? value : new URL(value); } catch { return false; }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}
