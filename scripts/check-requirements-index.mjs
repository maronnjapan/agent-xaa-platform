#!/usr/bin/env node
// T-DOCS-01. The index is only useful if every row points at something real.
//
// It checks the shape of each id, that none repeats, and that a `planned` row names a
// task heading that actually exists — the last of these is what stops the table drifting
// as tasks are renamed or merged.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const violations = [];

async function taskIds() {
  const ids = new Set();
  for (const directory of ['tasks', 'tasks/done']) {
    let entries;
    try { entries = await readdir(join(root, directory)); } catch { continue; }
    for (const entry of entries.filter((name) => name.endsWith('.md'))) {
      const text = await readFile(join(root, directory, entry), 'utf8');
      for (const match of text.matchAll(/^### (T-[A-Z]+-\d{2}) /gm)) ids.add(match[1]);
    }
  }
  return ids;
}

const known = await taskIds();
const table = await readFile(join(root, 'docs/requirements.md'), 'utf8');
// The header row also begins `| REQ-`; only rows with a real id are data.
const rows = table.split('\n').filter((line) => /^\| REQ-\d{2}-\d{3} /.test(line));
const seen = new Set();

for (const row of rows) {
  const cells = row.split('|').map((cell) => cell.trim());
  const [, id, title, source, tasks, state] = cells;
  if (!/^REQ-\d{2}-\d{3}$/.test(id ?? '')) violations.push(`bad requirement id: ${id}`);
  if (seen.has(id)) violations.push(`duplicate requirement id: ${id}`);
  seen.add(id);
  if (state !== 'planned' && state !== 'deferred') violations.push(`${id}: state must be planned or deferred`);
  if (!title || !source) violations.push(`${id}: title and source must not be empty`);
  if (state === 'planned') {
    for (const task of (tasks ?? '').split('/').map((value) => value.trim()).filter(Boolean)) {
      if (!known.has(task)) violations.push(`${id}: no such task ${task}`);
    }
  } else if (tasks !== '-') {
    violations.push(`${id}: a deferred row must leave the task column as -`);
  }
}

if (rows.length === 0) violations.push('the index has no rows');
for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(`ok: ${rows.length} requirements, every planned row names a real task`);
