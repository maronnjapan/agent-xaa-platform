#!/usr/bin/env node
// T-DOCS-10 / REQ-01-021. Two questions about the glossary, asked mechanically.
//
// First, do the names it lists still exist? A dictionary that has drifted from the code
// is worse than none: it tells a reader a name that no longer means anything.
//
// Second, has a discarded alias crept back in? Every one of them was rejected in favour
// of a name that is already in use, and a second name for the same thing is how two
// components come to disagree about what they are talking about.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const strict = process.argv.includes('--strict');
const violations = [];

const glossary = await readFile(join(root, 'docs/glossary.md'), 'utf8');
const rows = glossary.split('\n').filter((line) => /^\| [^|]+ \| .+ \| .+ \| \d{2}\. §/.test(line));
if (rows.length !== 26) violations.push(`the glossary must list 26 terms, found ${rows.length}`);

for (const row of rows) {
  const cells = row.split('|').map((cell) => cell.trim());
  const [, term, definition, identifiers, source] = cells;
  if (!term || !definition) violations.push(`${term}: term and definition must not be empty`);
  if (!/^\d{2}\. §\d/.test(source ?? '')) violations.push(`${term}: source must read like "01. §3.4"`);
  if (!identifiers) violations.push(`${term}: identifier column must not be empty`);
}

const forbidden = (await readFile(join(root, 'docs/glossary.forbidden.txt'), 'utf8'))
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
if (forbidden.length < 10) violations.push(`the forbidden list must name at least 10 aliases, found ${forbidden.length}`);

const SCAN_ROOTS = ['apps', 'packages', 'infra', 'e2e', 'docs', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', 'generated-baseline', '.git', 'public']);

async function walk(path, visit) {
  const info = await stat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (SKIP.has(entry)) continue;
      await walk(join(path, entry), visit);
    }
    return;
  }
  if (!/\.(ts|tsx|mjs|js|json|tf|md|yaml|yml|sql)$/.test(path)) return;
  await visit(path, await readFile(path, 'utf8'));
}

// The glossary lists the aliases in order to forbid them, and so does this script. A
// test that asserts a discarded name is refused has to write it down too — the rule is
// about what the platform *uses*, not about what may be mentioned.
const ALLOWED_TO_NAME = new Set(['docs/glossary.md', 'docs/glossary.forbidden.txt', 'scripts/check-glossary.mjs']);
const isRejectionTest = (relative) => /\/test\//.test(relative) || relative.endsWith('.spec.ts');

for (const scanRoot of SCAN_ROOTS) {
  await walk(join(root, scanRoot), (path, text) => {
    const relative = path.slice(root.length);
    if (ALLOWED_TO_NAME.has(relative) || isRejectionTest(relative)) return;
    for (const alias of forbidden) {
      if (text.includes(alias)) violations.push(`${relative}: uses the discarded alias ${alias}`);
    }
  });
}

if (strict) {
  const sources = [];
  for (const scanRoot of ['apps', 'packages']) {
    await walk(join(root, scanRoot), (path, text) => {
      if (path.endsWith('.ts') || path.endsWith('.tsx')) sources.push(text);
    });
  }
  const haystack = sources.join('\n');
  for (const row of rows) {
    const cells = row.split('|').map((cell) => cell.trim());
    const [, term, , identifiers] = cells;
    for (const identifier of (identifiers ?? '').split(' / ').map((value) => value.replaceAll('`', '').trim())) {
      if (!identifier || identifier === '-') continue;
      // A Firestore path with a placeholder is checked by its collection name alone.
      const needle = identifier.split('/')[0];
      if (needle && !haystack.includes(needle)) violations.push(`${term}: no such identifier ${needle}`);
    }
  }
}

for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(`ok: ${rows.length} terms, ${forbidden.length} discarded aliases absent${strict ? ', every identifier real' : ''}`);
