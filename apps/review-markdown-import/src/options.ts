import { join } from 'node:path';
import { LEDGER_FILE } from './ledger.js';
import { REVIEW_DIR } from './tasks.js';

/**
 * What the command was asked to do.
 *
 * The token is read from the environment and has no flag. A flag would put a live
 * Access Token into the shell's history and into `ps` output on a shared machine, and
 * this token opens the API that registers work for someone's agents. The URL may be
 * given either way because it is not a secret.
 */

export const USAGE = `usage: pnpm review:import <review-root> [--url <url>] [--state <path>] [--dry-run]

Registers the tasks a reviewer committed to in review-markdown-cli as draft ToDos.

  <review-root>  the directory review-markdown was run on (it holds .review/)
  --url <url>    the Automation App to register with; default $AUTOMATION_APP_URL
  --state <path> where to record what was registered;
                 default <review-root>/${REVIEW_DIR}/${LEDGER_FILE}
  --dry-run      show what would be registered and send nothing
  -h, --help     show this

environment:
  AUTOMATION_APP_URL           the Automation App, when --url is not given
  AUTOMATION_APP_ACCESS_TOKEN  a Human IdP Access Token for it
                               (aud=automation-app, scope agent:operate)

Registration stops at the draft. Confirming a ToDo, approving what it may use and
creating the agent are done by a person on the Automation App screen.`;

export interface Options {
  root: string;
  automationAppUrl: string;
  token: string;
  statePath: string;
  dryRun: boolean;
}

export class InvalidOptions extends Error {
  constructor(reason: string, readonly showUsage = true) {
    super(reason);
    this.name = 'InvalidOptions';
  }
}

/** Set when `--help` was asked for, so the caller prints the usage and stops at 0. */
export const HELP_REQUESTED = Symbol('help');

export function readOptions(argv: string[], env: NodeJS.ProcessEnv): Options | typeof HELP_REQUESTED {
  if (argv.includes('--help') || argv.includes('-h')) return HELP_REQUESTED;

  let root = '';
  let url = '';
  let statePath = '';
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--url' || argument === '--state') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw new InvalidOptions(`${argument} needs a value`);
      if (argument === '--url') url = value;
      else statePath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new InvalidOptions(`unknown option: ${argument}`);
    if (root !== '') throw new InvalidOptions('give one review root, not several');
    root = argument;
  }

  if (root === '') throw new InvalidOptions('give the directory review-markdown was run on');

  const automationAppUrl = (url || env.AUTOMATION_APP_URL || '').trim().replace(/\/+$/, '');
  if (automationAppUrl === '') {
    throw new InvalidOptions('set the Automation App with --url or AUTOMATION_APP_URL');
  }
  if (!/^https?:\/\/[^\s]+$/.test(automationAppUrl)) {
    throw new InvalidOptions(`not an http(s) URL: ${automationAppUrl}`, false);
  }

  // A dry run reads and reports; it never presents a credential, so it needs none.
  const token = (env.AUTOMATION_APP_ACCESS_TOKEN ?? '').trim();
  if (token === '' && !dryRun) {
    throw new InvalidOptions('set AUTOMATION_APP_ACCESS_TOKEN to a Human IdP Access Token for the Automation App', false);
  }

  return {
    root,
    automationAppUrl,
    token,
    statePath: statePath === '' ? join(root, REVIEW_DIR, LEDGER_FILE) : statePath,
    dryRun,
  };
}
