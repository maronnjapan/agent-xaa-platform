import { runAgent } from './run.js';

/**
 * The container entry point. Everything the Execution does lives in `run.ts`, so a
 * runner that hosts an Execution instead of being one can call the same code without
 * taking a `process.exit` with it.
 */
process.exit(await runAgent());
