import { ModelConfigurationError } from '@xaa/model';
import { startLocalPlatform, type RunningPlatform } from './runner.js';

/**
 * The whole platform, on one machine, with no Docker and no database to install.
 *
 * `pnpm local` builds the workspace and runs this. Everything a person can do against
 * the deployed platform they can do against this one, at the URLs it prints.
 */

/**
 * A model that was named but cannot be built is the one thing this can be stopped by,
 * and the one thing a person can fix from the message alone: a key that is not set, a
 * command that is not installed. A stack trace through the composition root says none of
 * that, so the message goes out on its own and the process ends on it.
 */
let running: RunningPlatform;
try {
  running = await startLocalPlatform();
} catch (error) {
  if (!(error instanceof ModelConfigurationError)) throw error;
  process.stderr.write(`\n[local] ${error.message}\n\n  See docs/local-development.md §3 for every model this can be pointed at.\n\n`);
  process.exit(1);
}

const stop = (signal: NodeJS.Signals): void => {
  process.stdout.write(`\n[local] ${signal}: stopping\n`);
  void running.stop().then(() => { process.exit(0); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
