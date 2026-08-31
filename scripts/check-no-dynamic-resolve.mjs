#!/usr/bin/env node
// T-RUN-21. REQ-04-015 and REQ-07-008 forbid the Runtime from working out where to go
// at run time. The words below name the mechanisms that would let it: a catalogue
// lookup, a registry, OIDC discovery, or a database it has no business reading.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = join(root, 'apps/agent-runtime/src');
const FORBIDDEN = ['tool_catalog', 'registry', 'discovery', '.well-known', 'cloudsql'];
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const text = (await readFile(path, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) violations.push([relative(root, path), needle]);
    }
  }
}

await walk(source);
for (const [path, needle] of violations) console.error(`${path} / ${needle} / the Runtime must not resolve destinations at run time`);
if (violations.length > 0) process.exit(1);
