#!/usr/bin/env node
// T-DOCS-13. A cross-reference that points nowhere is worse than no link: it tells the
// reader the detail exists somewhere and then wastes their time.
//
// Both halves are checked — the file, and the anchor within it — because a renamed
// heading breaks a link silently while the file still resolves.
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const violations = [];

/**
 * GitHub's rule: lower-case, drop punctuation but keep underscores, and turn each space
 * into a hyphen — each one, so `6. Expiration / 緊急停止` becomes `6-expiration--緊急停止`
 * with the pair of hyphens the removed slash leaves behind.
 */
function toAnchor(heading) {
  return `#${heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')}`;
}

/** Every document under docs/, not only the ones directly in it. */
async function markdownUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await markdownUnder(path));
    else if (entry.name.endsWith('.md')) found.push(relative(join(root, 'docs'), path));
  }
  return found.sort();
}

const files = await markdownUnder(join(root, 'docs'));
const verbose = process.argv.includes('--verbose');
if (verbose) for (const name of files) console.log(`checking docs/${name}`);
const anchors = new Map();
for (const name of files) {
  const text = await readFile(join(root, 'docs', name), 'utf8');
  anchors.set(name, new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => toAnchor(match[1]))));
}

for (const name of files) {
  const text = await readFile(join(root, 'docs', name), 'utf8');
  // Reference-style links and raw HTML are not checkable by this script and are not
  // needed: the two inline forms cover every cross-reference in these documents.
  if (/\][ ]?\[[^\]]+\]/.test(text)) violations.push(`${name}: uses a reference-style link`);
  if (/<a\s/i.test(text)) violations.push(`${name}: uses an HTML <a> link`);

  for (const link of text.matchAll(/\[[^\]]*\]\(([^)\s#]+)(#[^)\s]*)?\)/g)) {
    const [, href, anchor] = link;
    if (/^[a-z]+:/i.test(href)) continue;
    // Relative to the document that carries the link, then named from docs/ so it can
    // be looked up in the same map whatever directory it lives in.
    const target = relative(join(root, 'docs'), resolve(join(root, 'docs', dirname(name)), href));
    if (!anchors.has(target)) {
      // Not a document: a diagram or another asset, checked as a file on disk.
      try {
        await access(join(root, 'docs', target));
      } catch {
        violations.push(`${name}: links to ${target}, which does not exist`);
      }
      continue;
    }
    if (anchor && !anchors.get(target).has(anchor)) {
      violations.push(`${name}: links to ${target}${anchor}, which is not a heading there`);
    }
  }
  for (const link of text.matchAll(/\]\((#[^)]+)\)/g)) {
    if (!anchors.get(name).has(link[1])) violations.push(`${name}: links to ${link[1]}, which is not a heading here`);
  }
}

for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(`ok: every cross-reference in ${files.length} documents resolves`);
