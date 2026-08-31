#!/usr/bin/env node
// T-DOCS-03 / RULE-45. A deviation register is a control only while every column is
// filled: an entry with no test behind it is a claim, not a guarantee.
//
// Two modes. The default checks the table's own completeness and runs everywhere. The
// strict mode additionally opens every path and greps every test name, which needs the
// implementation to exist — so it becomes required once the build is complete.
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const strict = process.argv.includes('--strict');
const violations = [];

const table = await readFile(join(root, 'docs/deviations.md'), 'utf8');
const rows = table.split('\n').filter((line) => /^\| \*\*DEV-/.test(line));
const seen = [];

for (const row of rows) {
  const cells = row.split('|').map((cell) => cell.trim());
  const [, idCell, ruleCell, implCell, testCell, scopeCell] = cells;
  const id = (idCell ?? '').replaceAll('*', '');
  if (!/^DEV-\d{2}$/.test(id)) { violations.push(`bad deviation id: ${idCell}`); continue; }
  seen.push(id);

  // A withdrawn deviation keeps its number so nothing renumbers around it.
  if ((ruleCell ?? '').includes('取り下げ')) {
    for (const cell of [implCell, testCell, scopeCell]) {
      if (cell !== '-' && !(cell ?? '').startsWith('なし')) {
        violations.push(`${id}: a withdrawn row must leave the remaining columns as -`);
      }
    }
    continue;
  }

  for (const [name, cell] of [['rule', ruleCell], ['implementation', implCell], ['test', testCell], ['scope', scopeCell]]) {
    if (!cell) violations.push(`${id}: the ${name} column is empty`);
  }

  const paths = (implCell ?? '').split('/').length > 0
    ? (implCell ?? '').split(' / ').map((value) => value.replaceAll('`', '').trim()).filter(Boolean)
    : [];
  if (!paths.some((path) => /^(apps|packages|infra|e2e)\//.test(path))) {
    violations.push(`${id}: the implementation column names no path under apps, packages, infra or e2e`);
  }

  const tests = (testCell ?? '').split(' / ').map((value) => value.replaceAll('`', '').trim()).filter(Boolean);
  let currentPath = '';
  for (const entry of tests) {
    if (entry.includes('::')) {
      const [path, name] = entry.split('::');
      currentPath = (path ?? '').trim();
      const testName = (name ?? '').trim();
      if (!currentPath || !testName) violations.push(`${id}: a test entry must read <path>::<name>`);
      else if (strict) await checkTest(id, currentPath, testName);
    } else if (currentPath) {
      // A second name under the same path, written after ` / `.
      if (strict) await checkTest(id, currentPath, entry);
    } else {
      violations.push(`${id}: a test entry must read <path>::<name>`);
    }
  }

  if (strict) {
    for (const path of paths) {
      try { await access(join(root, path)); } catch { violations.push(`${id}: no such path ${path}`); }
    }
  }
}

const expected = Array.from({ length: 15 }, (_unused, index) => `DEV-${String(index + 1).padStart(2, '0')}`);
if (seen.join(',') !== expected.join(',')) {
  violations.push(`deviation ids must run DEV-01 to DEV-15 with no gaps; found ${seen.join(', ')}`);
}
if (!table.includes('## 2. REQ-10-004')) violations.push('the mapping to REQ-10-004 is missing');

async function checkTest(id, path, name) {
  let text;
  try { text = await readFile(join(root, path), 'utf8'); } catch {
    violations.push(`${id}: no such test file ${path}`);
    return;
  }
  if (!text.includes(name)) violations.push(`${id}: ${path} contains no test named ${name}`);
}

for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(`ok: ${rows.length} deviations, every column filled${strict ? ' and every reference real' : ''}`);
