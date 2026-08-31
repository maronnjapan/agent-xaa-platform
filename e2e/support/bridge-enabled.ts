/**
 * The Bridge is off by default (DEC-SCOPE-04), so its specs are skipped unless the
 * deployment being tested has it on. The condition lives here rather than in each spec
 * so there is one place to look when a Bridge test does not run.
 */
export const BRIDGE_ENABLED = process.env.ENABLE_GOOGLE_BRIDGE === 'true';
