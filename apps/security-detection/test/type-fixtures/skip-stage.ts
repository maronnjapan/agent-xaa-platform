import { createPipelineDeps } from '../../src/pipeline/index.js';

const deps = createPipelineDeps({ baselines: new Map(), counters: { low_events_total: 0, unmapped_code_total: 0 } });

/**
 * Deliberately uncompilable. Correlating a batch that never went through protocol
 * validation or the rules is the mistake the branded stage types exist to prevent, and
 * this file is the proof that they do: `pnpm tsc --noEmit -p` over this directory has to
 * fail, and `detection.spec.ts` fails if it ever starts succeeding.
 */
export const skipped = deps.correlate(deps.normalize(deps.collect([])));
