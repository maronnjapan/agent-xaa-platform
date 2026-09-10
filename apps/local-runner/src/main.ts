import { startLocalPlatform } from './runner.js';

/**
 * The whole platform, on one machine, with no Docker and no database to install.
 *
 * `pnpm local` builds the workspace and runs this. Everything a person can do against
 * the deployed platform they can do against this one, at the URLs it prints.
 */
const running = await startLocalPlatform();

const stop = (signal: NodeJS.Signals): void => {
  process.stdout.write(`\n[local] ${signal}: stopping\n`);
  void running.stop().then(() => { process.exit(0); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
