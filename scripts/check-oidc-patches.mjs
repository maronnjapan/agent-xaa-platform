import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
// The platform's own OIDC providers. `stub-saas-op` is not among them: it stands in for
// an external SaaS during tests, so it is a fixture rather than a provider this platform
// operates, and generating it from the same toolchain would prove nothing about the
// platform while leaving a second copy of that toolchain to keep in step.
const apps = ['human-idp', 'resource-docs-as', 'resource-finance-as'];
const errors = [];

async function files(path, prefix = '') {
  const result = [];
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (entry.isDirectory()) result.push(...await files(join(path, entry.name), join(prefix, entry.name)));
    else result.push(join(prefix, entry.name));
  }
  return result.sort();
}

function stripPatches(source, file) {
  const output = [];
  let open;
  for (const [index, line] of source.split('\n').entries()) {
    const marker = line.match(/^\s*\/\/ XAA-PATCH:([^ ]+) (begin|end)\s*$/);
    if (!marker) { if (!open) output.push(line); continue; }
    if (!/^REQ-\d{2}-\d{3}$/.test(marker[1])) errors.push(`${file}:${index + 1}: invalid patch requirement id`);
    if (marker[2] === 'begin') {
      if (open) errors.push(`${file}:${index + 1}: nested patch marker`);
      open = marker[1];
    } else {
      if (!open || open !== marker[1]) errors.push(`${file}:${index + 1}: unmatched patch end`);
      open = undefined;
    }
  }
  if (open) errors.push(`${file}: unmatched patch begin`);
  return output.join('\n');
}

for (const app of apps) {
  const actualRoot = join(root, 'apps', app, 'src/oidc');
  const baselineRoot = join(root, 'generated-baseline', app);
  const actualFiles = await files(actualRoot); const baselineFiles = await files(baselineRoot);
  if (actualFiles.join('\n') !== baselineFiles.join('\n')) { errors.push(`${app}: generated file set differs`); continue; }
  for (const file of actualFiles) {
    const actual = stripPatches(await readFile(join(actualRoot, file), 'utf8'), relative(root, join(actualRoot, file)));
    const baseline = await readFile(join(baselineRoot, file), 'utf8');
    if (actual !== baseline) errors.push(`${relative(root, join(actualRoot, file))}: marker-external content differs`);
  }
}
for (const error of errors) console.error(error);
if (errors.length) process.exit(1);
