import { AutomationAppRefusal, createAutomationApp, type AutomationApp } from './client.js';
import { alreadyRegistered, ledgerKey, readLedger, writeLedger, type Ledger } from './ledger.js';
import { HELP_REQUESTED, InvalidOptions, readOptions, USAGE, type Options } from './options.js';
import { scanCommittedTasks, type ReviewTask } from './tasks.js';
import { buildTodoRequest, TaskNotRegisterable } from './todo.js';

/**
 * The command, from arguments to exit code.
 *
 * One task refused does not stop the ones after it. A run over a directory of documents
 * is a batch of independent errands, and a reviewer who has to re-run everything because
 * the third of forty was too long will stop running it. Refusals are reported line by
 * line and counted; the exit code says whether any occurred.
 *
 * What was registered is written to the ledger after each success rather than at the
 * end, so that a run cut short leaves nothing to be registered a second time.
 */

export interface ImportDeps {
  out(line: string): void;
  err(line: string): void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?(): Date;
  /** Replaces the API client; the tests use it instead of a fetch double. */
  createApp?(options: Options): AutomationApp;
}

type Outcome = 'registered' | 'refused';

export async function runImport(argv: string[], deps: ImportDeps): Promise<number> {
  let options: Options;
  try {
    const read = readOptions(argv, deps.env ?? process.env);
    if (read === HELP_REQUESTED) {
      deps.out(USAGE);
      return 0;
    }
    options = read;
  } catch (error) {
    if (!(error instanceof InvalidOptions)) throw error;
    deps.err(error.message);
    if (error.showUsage) deps.err(USAGE);
    return 1;
  }

  const scan = await scanCommittedTasks(options.root);
  for (const path of scan.unreadable) deps.err(`skipped ${path}: it is not readable as JSON`);

  const ledger = await readLedger(options.statePath);
  // A dry run builds no client, so it cannot reach the network even by mistake.
  const app = options.dryRun ? null : (deps.createApp ?? defaultApp(deps))(options);
  const now = deps.now ?? (() => new Date());

  let registered = 0;
  let skipped = 0;
  let refused = scan.unreadable.length;

  for (const document of scan.documents) {
    for (const task of document.tasks) {
      const key = ledgerKey(document.documentPath, task.id);
      if (alreadyRegistered(ledger, key, options.automationAppUrl)) {
        skipped += 1;
        continue;
      }
      const outcome = await registerOne({ task, documentPath: document.documentPath, key, app, ledger, options, now, deps });
      if (outcome === 'refused') refused += 1;
      else registered += 1;
    }
  }

  deps.out(summary({ registered, skipped, refused, dryRun: options.dryRun }));
  return refused > 0 ? 1 : 0;
}

async function registerOne(input: {
  task: ReviewTask;
  documentPath: string;
  key: string;
  app: AutomationApp | null;
  ledger: Ledger;
  options: Options;
  now(): Date;
  deps: ImportDeps;
}): Promise<Outcome> {
  const { task, key, app, ledger, options, deps } = input;

  let body;
  try {
    body = buildTodoRequest(task, input.documentPath);
  } catch (error) {
    if (!(error instanceof TaskNotRegisterable)) throw error;
    deps.err(`refused ${key}: ${error.message}`);
    return 'refused';
  }

  if (!app) {
    deps.out(`would register ${key}: ${task.title}`);
    return 'registered';
  }

  try {
    const created = await app.registerTodo(body);
    ledger.entries[key] = {
      work_definition_id: created.work_definition_id,
      automation_app_url: options.automationAppUrl,
      imported_at: input.now().toISOString(),
    };
    await writeLedger(options.statePath, ledger);
    deps.out(`registered ${key} as ${created.work_definition_id}: ${task.title}`);
    return 'registered';
  } catch (error) {
    if (!(error instanceof AutomationAppRefusal)) throw error;
    deps.err(`refused ${key}: ${error.message}`);
    return 'refused';
  }
}

/**
 * What the run did, in one line.
 *
 * "already registered" is named rather than left out: a second run that reports nothing
 * reads like a run that failed to find anything.
 */
function summary(counts: { registered: number; skipped: number; refused: number; dryRun: boolean }): string {
  const parts = [
    `${counts.dryRun ? 'would register' : 'registered'} ${counts.registered}`,
    `already registered ${counts.skipped}`,
  ];
  if (counts.refused > 0) parts.push(`refused ${counts.refused}`);
  return parts.join(', ');
}

function defaultApp(deps: ImportDeps): (options: Options) => AutomationApp {
  return (options) => createAutomationApp({
    baseUrl: options.automationAppUrl,
    token: options.token,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}
