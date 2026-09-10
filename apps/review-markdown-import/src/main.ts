import { runImport } from './import.js';

process.exit(await runImport(process.argv.slice(2), {
  out: (line) => { process.stdout.write(`${line}\n`); },
  err: (line) => { process.stderr.write(`${line}\n`); },
}));
