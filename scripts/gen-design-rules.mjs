#!/usr/bin/env node
// T-DOCS-04 / REQ-10-001. The rules live in docs/rules.json; the Markdown is generated
// from it.
//
// A hand-maintained table and a machine-readable list of the same 60 rules will drift,
// and when they do there is no way to say which is right. Generating one from the other
// removes the question. Nothing in 10-design-rules.md is hand-written.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const registry = JSON.parse(await readFile(join(root, 'docs/rules.json'), 'utf8'));

const lines = ['# 10. 設計ルール', '', registry.preamble, ''];

// Declaration order, not id order: the rules were grouped by subject before they were
// numbered, and reordering them by id would scatter each subject across the document.
for (const category of registry.categories) {
  lines.push(`## ${category.title}`, '', '| ID | ルール | 出典 |', '|---|---|---|');
  for (const rule of registry.rules.filter((entry) => entry.category === category.id)) {
    const sources = rule.sources.map((source) => `[${source.label}](./${source.doc}${source.anchor})`).join('、');
    lines.push(`| ${rule.id} | ${rule.text} | ${sources} |`);
  }
  lines.push('');
}

await writeFile(join(root, 'docs/10-design-rules.md'), `${lines.join('\n').trimEnd()}\n`);
console.log(`ok: generated ${registry.rules.length} rules in ${registry.categories.length} categories`);
