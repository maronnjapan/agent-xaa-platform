import { describe, expect, it } from 'vitest';
import { createBridgeHarness } from '../src/testing/harness.js';

/**
 * The route surface, pinned.
 *
 * One codebase runs as two Cloud Run services and the split is the security boundary:
 * the internal face issues tokens and is reachable only by named service accounts, the
 * callback face is the only half a browser can reach and issues nothing. A route added
 * to the wrong face would not fail any behavioural test — it would simply be there —
 * so the set of paths is compared against a committed snapshot instead.
 *
 * docs 06 §2's "the Bridge does not do this" is the other half of the same check: no
 * `/calendar`, `/gmail` or `/proxy` prefix can appear without the snapshot changing.
 */
describe('routes snapshot', () => {
  it('matches the committed route table for both faces', async () => {
    const harness = createBridgeHarness();
    const text = [
      '# internal face (BRIDGE_FACE=internal)',
      ...harness.routes.internal,
      '',
      '# callback face (BRIDGE_FACE=callback)',
      ...harness.routes.callback,
      '',
    ].join('\n');
    await expect(text).toMatchFileSnapshot('./__snapshots__/routes.snap');
  });

  it('mounts eight internal routes and three callback routes', () => {
    const harness = createBridgeHarness();
    // Eight, not seven: 00b §4 adds `POST /connections/{connection_id}/revoke-upstream`
    // as the eighth internal route, which the Lifecycle Manager's step5 calls.
    expect(harness.routes.internal).toEqual([
      'DELETE /bindings/:agent_id',
      'GET /healthz',
      'POST /bindings',
      'POST /bindings/:agent_id/disable',
      'POST /connections/:connection_id/revoke-upstream',
      'POST /connections/check',
      'POST /connections/verify',
      'POST /token',
    ]);
    expect(harness.routes.callback).toEqual([
      'GET /:connector_id/oauth/callback',
      'GET /:connector_id/oauth/start',
      'GET /healthz',
    ]);
  });

  it('names no business API path on either face', () => {
    const harness = createBridgeHarness();
    for (const route of [...harness.routes.internal, ...harness.routes.callback]) {
      for (const forbidden of ['/calendar', '/gmail', '/proxy']) {
        expect(route).not.toContain(forbidden);
      }
    }
  });

  it('keeps /connections/verify off the browser-facing face', () => {
    // T-BRIDGE-17: verify is a server-to-server call. A browser that could reach it
    // would be able to spend a one-time code the Provisioner is waiting for.
    const harness = createBridgeHarness();
    expect(harness.routes.callback.some((route) => route.includes('/connections/verify'))).toBe(false);
    expect(harness.routes.internal).toContain('POST /connections/verify');
  });
});
