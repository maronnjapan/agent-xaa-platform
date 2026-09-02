#!/usr/bin/env node
// T-RUN-03 / T-RUN-15. What an Agent Runtime must not be able to reach, decided by
// grep rather than by review: a refresh token, a client secret, the IdP connection
// store, Secret Manager, or the metadata server outside the one file allowed to use
// it. Also pins Bearer-header construction to the resource authorization module, so
// a Service Account ID Token cannot be attached to a resource call by hand.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = join(root, 'apps/agent-runtime/src');

const FORBIDDEN = [
  'refresh_token', 'client_secret', 'REFRESH_TOKEN', 'CLIENT_SECRET',
  'idp_connections', 'secretmanager',
];
const METADATA = ['metadata.google.internal', '169.254.169.254'];
const METADATA_FILE = 'http/internal-invoker-token.ts';
// The two modules allowed to name a Bearer header: the Cloud Run invoker header, and
// the external-SaaS header of the bridged path. Both take a branded token type, so a
// Service Account ID Token cannot reach either one.
const BEARER_FILES = new Set(['http/internal-invoker-token.ts', 'http/resource-authorization.ts']);

// Two files name these values in order to refuse them: the checkpoint sanitiser
// denylists the key, and the subject-token parser fails when the OP sends one. They
// are the enforcement, so exempting them is not a loophole — it is what the rule is for.
const GUARD_FILES = new Set(['state/sanitize.ts', 'tokens/subject-token.ts']);

const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    const relativePath = relative(source, path);
    // Comments are prose; the rule is about code.
    const text = (await readFile(path, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (!GUARD_FILES.has(relativePath)) {
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) violations.push([relativePath, needle, 'forbidden credential reference']);
      }
    }
    for (const needle of METADATA) {
      if (text.includes(needle) && relativePath !== METADATA_FILE) {
        violations.push([relativePath, needle, `metadata server is only reachable from ${METADATA_FILE}`]);
      }
    }
    if (/Authorization['"]?\s*:\s*[`'"]Bearer/.test(text) && !BEARER_FILES.has(relativePath)) {
      violations.push([relativePath, 'Authorization: Bearer', 'build resource authorization through resource-authorization.ts']);
    }
  }
}

await walk(source);
for (const [path, needle, reason] of violations) console.error(`apps/agent-runtime/src/${path} / ${needle} / ${reason}`);
if (violations.length > 0) process.exit(1);
