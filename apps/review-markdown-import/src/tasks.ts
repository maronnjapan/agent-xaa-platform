import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What review-markdown-cli leaves on disk, read from this side of the connection.
 *
 * The review tool writes one file per reviewed document, at
 * `<root>/.review/<document path>.tasks.json`, and its README documents the shape for
 * anything that wants to read it. That published file is the whole interface between
 * the two tools: the review tool holds no address, no token and no knowledge of this
 * platform, and this app never asks it for anything. It reads what is already there.
 *
 * Reading is lenient, for the same reason the review tool's own reader is: these files
 * are edited by hand and written by a background process, so one malformed entry must
 * cost that entry and nothing else. A file that cannot be parsed at all is reported by
 * name rather than passed over in silence — a reviewer who sees "nothing to register"
 * should not be looking at a typo.
 */

export const REVIEW_DIR = '.review';
export const TASKS_FILE_SUFFIX = '.tasks.json';

/** The review tool's three priorities, in its own words. */
export const REVIEW_PRIORITIES = ['now', 'next', 'later'] as const;
export type ReviewPriority = (typeof REVIEW_PRIORITIES)[number];

/**
 * One task, reduced to the fields that mean something to a ToDo.
 *
 * The review record carries more — what the AI produced for the task, how far the
 * document had been read, which files were attached as references — and none of it
 * belongs in work handed to an agent, so none of it is read here.
 */
export interface ReviewTask {
  id: string;
  title: string;
  detail: string;
  priority: ReviewPriority;
  owner: string;
  quote: string;
  knowledge: string;
  due: string;
}

export interface ReviewDocument {
  /** The reviewed document, as a path relative to the review root. */
  documentPath: string;
  tasks: ReviewTask[];
}

export interface ScanResult {
  documents: ReviewDocument[];
  /** Task files that could not be read or parsed, by path relative to the root. */
  unreadable: string[];
}

/**
 * Every task the reviewer decided to do and has not finished, document by document.
 *
 * The filter is the review tool's own distinction, kept deliberately: a task is
 * `committed` once the reviewer has read it and said they will do it. Tasks an AI
 * merely proposed sit in the same file, unread, and registering those would put work
 * nobody has agreed to in front of an agent.
 */
export async function scanCommittedTasks(root: string): Promise<ScanResult> {
  const result: ScanResult = { documents: [], unreadable: [] };
  await walk(join(root, REVIEW_DIR), '');
  result.documents.sort((left, right) => left.documentPath.localeCompare(right.documentPath));
  result.unreadable.sort();
  return result;

  async function walk(directory: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // No `.review` yet, or a path that is not a directory: nothing was reviewed here.
      return;
    }
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(TASKS_FILE_SUFFIX)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
      } catch {
        result.unreadable.push(`${REVIEW_DIR}/${path}`);
        continue;
      }
      // The document is named by where its task file sits, not by the `targetFile` the
      // file claims: the location is a fact, the field is a value someone can mistype.
      const documentPath = path.slice(0, -TASKS_FILE_SUFFIX.length);
      const tasks = readCommittedTasks(parsed);
      if (tasks.length > 0) result.documents.push({ documentPath, tasks });
    }
  }
}

function readCommittedTasks(value: unknown): ReviewTask[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return [];
  return value.tasks.map(readTask).filter((task): task is ReviewTask => task !== null);
}

/**
 * One task, or nothing.
 *
 * Nothing is returned for a task with no title (there is no ToDo to make of it), for
 * one the reviewer has not committed to, and for one already finished or set aside —
 * the three the review tool's own "register" button refused, kept here so that moving
 * the connection did not quietly widen what gets registered.
 */
function readTask(value: unknown): ReviewTask | null {
  if (!isRecord(value)) return null;
  const plan = isRecord(value.plan) ? value.plan : {};
  if (plan.commitment !== 'committed') return null;
  if (value.status === 'done' || value.status === 'dismissed') return null;
  const title = text(value.title).trim();
  const id = text(value.id).trim();
  if (title === '' || id === '') return null;
  const reference = isRecord(value.reference) ? value.reference : {};
  return {
    id,
    title,
    detail: text(value.detail),
    priority: isReviewPriority(value.priority) ? value.priority : 'next',
    owner: text(value.owner),
    quote: text(value.quote),
    knowledge: text(reference.knowledge),
    due: text(plan.due),
  };
}

function isReviewPriority(value: unknown): value is ReviewPriority {
  return (REVIEW_PRIORITIES as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
