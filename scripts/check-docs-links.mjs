#!/usr/bin/env node
// T-DOCS-13. A cross-reference that points nowhere is worse than no link: it tells the
// reader the detail exists somewhere and then wastes their time.
//
// Both halves are checked — the file, and the anchor within it — because a renamed
// heading breaks a link silently while the file still resolves.
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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

const files = (await readdir(join(root, 'docs'))).filter((name) => name.endsWith('.md'));
const anchors = new Map();
for (const name of files) {
  const text = await readFile(join(root, 'docs', name), 'utf8');
  anchors.set(name, new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => toAnchor(match[1]))));
}

for (const name of files) {
  const text = await readFile(join(root, 'docs', name), 'utf8');
  for (const link of text.matchAll(/\[[^\]]*\]\(\.\/([^)#]+)(#[^)]*)?\)/g)) {
    const [, target, anchor] = link;
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
