import { assertNoTokenInRedirect } from '@xaa/contracts';

/**
 * Runs every redirect an E2E produces through the same guard the services run before
 * they send one (T-BRIDGE-16).
 *
 * The hook exists so the specs contain no per-redirect assertion. A spec that has to
 * remember to check its own `Location` will eventually add a hop and forget, and the
 * one hop nobody checked is where a token ends up in a URL. Wrapping the transport
 * makes the check unconditional: any 3xx that passes through, from any hop, is checked
 * whether the spec was thinking about it or not.
 *
 * The platform's E2E runs the apps in-process rather than in a browser, so the hook
 * wraps the fetch-shaped function each harness exposes instead of a page's response
 * event. The property being enforced is the same one either way.
 */
export type Sender<A extends unknown[]> = (...args: A) => Response | Promise<Response>;

export function guardRedirects<A extends unknown[]>(send: Sender<A>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const response = await send(...args);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      // A 3xx with no Location is not a redirect anyone can follow, so there is
      // nothing to inspect; a 3xx with one is checked before the spec ever sees it.
      if (location) assertNoTokenInRedirect(location);
    }
    return response;
  };
}
