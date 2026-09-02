import { describe } from 'vitest';

/**
 * The Bridge is off by default (DEC-SCOPE-04), so its specs are skipped unless the
 * deployment being tested has it on. The condition lives here rather than in each spec
 * so there is one place to look when a Bridge test does not run.
 */
export const BRIDGE_ENABLED = process.env.ENABLE_GOOGLE_BRIDGE === 'true';

/**
 * Every Bridge spec opens with this instead of `describe`.
 *
 * A run without `ENABLE_GOOGLE_BRIDGE=true` reports these as skipped rather than
 * passing: with the flag off there is no `google-bridge` service, no `stub-saas-op` and
 * no `stub-saas-api` in the plan, so a green result would be describing a deployment
 * that does not exist. CI sets the flag, so the bridged path is still exercised on
 * every change.
 */
export function describeBridge(name: string, factory: () => void): void {
  describe.skipIf(!BRIDGE_ENABLED)(name, factory);
}
