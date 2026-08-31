import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const violations = [];
for (const app of await readdir(join(root, 'apps'), { withFileTypes: true })) {
  if (!app.isDirectory()) continue;
  const appFile = join(root, 'apps', app.name, 'src/app.ts');
  let source;
  try { source = await readFile(appFile, 'utf8'); } catch { continue; }
  if (!/export\s+default\s+createApp\b/.test(source)) violations.push(`${relative(root, appFile)}: must contain export default createApp`);
}
for (const violation of violations) console.error(violation);
if (violations.length) process.exit(1);
