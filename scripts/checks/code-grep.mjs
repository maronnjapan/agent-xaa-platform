#!/usr/bin/env node
// Greps source files with comments removed.
//
// Every one of these checks forbids a word from appearing in code. Prose that explains
// why the word is forbidden is not a violation — it is the reason the rule exists, and
// the comment is where a future contributor learns it. Stripping comments first lets
// the rule and its explanation live in the same file.
//
// Usage: node scripts/checks/code-grep.mjs '<regex>' <file|dir> [...]
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const [pattern, ...targets] = process.argv.slice(2);
if (!pattern || targets.length === 0) {
  console.error('usage: code-grep.mjs <regex> <path...>');
  process.exit(2);
}
const regex = new RegExp(pattern);
const hits = [];

async function walk(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await walk(join(path, entry));
    return;
  }
  if (!/\.(ts|tsx|mjs|js|md)$/.test(path)) return;
  const text = await readFile(path, 'utf8');
  const code = path.endsWith('.md')
    ? text
    : text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
  code.split('\n').forEach((line, index) => {
    if (regex.test(line)) hits.push(`${path}:${index + 1}:${line.trim()}`);
  });
}

for (const target of targets) await walk(target);
for (const hit of hits) console.log(hit);
process.exit(hits.length > 0 ? 1 : 0);
