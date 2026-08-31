import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const allowed = JSON.parse(await readFile(join(root, 'scripts/allowed-deps.json'), 'utf8'));
const forbidden = new Set(['jose', 'jsonwebtoken', 'node-jose', 'jwks-rsa', 'oidc-provider', 'openid-client', 'firebase', 'firebase-admin']);
const violations = [];

async function packageFiles() {
  const files = [join(root, 'package.json')];
  for (const parent of ['apps', 'packages', 'e2e']) {
    let entries;
    try { entries = await readdir(join(root, parent), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(join(root, parent, entry.name, 'package.json'));
    }
  }
  return files;
}

for (const file of await packageFiles()) {
  let pkg;
  try { pkg = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  for (const [field, allowKey] of [['dependencies', 'runtime'], ['devDependencies', 'dev']]) {
    for (const [name, version] of Object.entries(pkg[field] ?? {})) {
      const isWorkspace = name.startsWith('@xaa/') && String(version).startsWith('workspace:');
      if (!isWorkspace && !allowed[allowKey].includes(name)) violations.push([file, name, `not in ${allowKey} allowlist`]);
      if (forbidden.has(name)) violations.push([file, name, 'explicitly forbidden dependency']);
      if (!isWorkspace && /[\^~*xX<>]/.test(String(version))) violations.push([file, name, `version is not exact: ${version}`]);
    }
  }
}

for (const [file, name, reason] of violations) console.error(`${relative(root, file)} / ${name} / ${reason}`);
if (violations.length > 0) process.exit(1);
