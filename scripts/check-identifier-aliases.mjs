import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const canonical = join(root, 'packages/xaa-contracts/src/identifiers.ts');
const text = await readFile(canonical, 'utf8');
const literals = [...text.matchAll(/'((?:calendar|mail|document|finance|docs|gmail|internal|stub)\.[a-z_.]+)'/g)].map((match) => match[1]);
const violations = [];

async function walk(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!['dist', 'test', 'node_modules'].includes(entry.name)) await walk(full);
    } else if (entry.name.endsWith('.ts') && full !== canonical) {
      const source = await readFile(full, 'utf8');
      for (const literal of literals) if (source.includes(`'${literal}'`) || source.includes(`"${literal}"`)) violations.push(`${relative(root, full)}: identifier literal ${literal}`);
    }
  }
}
await walk(join(root, 'apps'));
for (const violation of violations) console.error(violation);
if (violations.length) process.exit(1);
