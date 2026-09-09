import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REVIEW_DIR } from './tasks.js';

/**
 * What this app has already registered, so that running it twice does not ask for the
 * same work twice.
 *
 * It is this app's own file, written beside the review tool's task files and never
 * inside them. That is the whole point of the arrangement: the review tool's records
 * stay records of the review, and nothing this platform does leaves a mark in them.
 * Delete this file and the next run registers everything again — it holds no authority,
 * only memory.
 *
 * An entry remembers which app it was sent to. Point the command at a different
 * Automation App and the same task is registered there too, because a ToDo drafted in
 * one deployment does not exist in another.
 */

export const LEDGER_FILE = '.automation-app-import.json';

export interface LedgerEntry {
  work_definition_id: string;
  automation_app_url: string;
  imported_at: string;
}

export interface Ledger {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

export function ledgerPath(root: string): string {
  return join(root, REVIEW_DIR, LEDGER_FILE);
}

/** One task of one document. The document path makes the reviewer's task ids unique. */
export function ledgerKey(documentPath: string, taskId: string): string {
  return `${documentPath}#${taskId}`;
}

export function emptyLedger(): Ledger {
  return { version: 1, entries: {} };
}

/** A ledger that cannot be read is an empty one: it must never block registering. */
export async function readLedger(path: string): Promise<Ledger> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return emptyLedger();
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyLedger();
  const entries = (parsed as { entries?: unknown }).entries;
  if (typeof entries !== 'object' || entries === null) return emptyLedger();
  const ledger = emptyLedger();
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = readEntry(value);
    if (entry) ledger.entries[key] = entry;
  }
  return ledger;
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

/** Whether this exact task has already been registered with this exact app. */
export function alreadyRegistered(ledger: Ledger, key: string, automationAppUrl: string): LedgerEntry | null {
  const entry = ledger.entries[key];
  return entry && entry.automation_app_url === automationAppUrl ? entry : null;
}

function readEntry(value: unknown): LedgerEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record.work_definition_id;
  const url = record.automation_app_url;
  if (typeof id !== 'string' || id === '' || typeof url !== 'string') return null;
  return {
    work_definition_id: id,
    automation_app_url: url,
    imported_at: typeof record.imported_at === 'string' ? record.imported_at : '',
  };
}
