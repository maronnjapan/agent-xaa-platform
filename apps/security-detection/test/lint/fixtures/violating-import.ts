// A file that does what T-SEC-18 forbids, kept outside `src` so nothing builds or runs
// it. `no-raw-log-to-ai.spec.ts` lints it with the boundary rule and expects errors: a
// lint rule nobody has watched fail is a lint rule that may already be misconfigured.
import { normalizeEntries } from '../../../src/normalize/index.js';
import { createLogger } from '@xaa/logging';

export function smuggleRawLogIntoTheModel(entries: readonly unknown[]): unknown {
  createLogger('security-detection', 'agent_op');
  return normalizeEntries(entries).events;
}
