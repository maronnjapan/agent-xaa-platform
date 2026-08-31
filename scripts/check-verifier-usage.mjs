import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const violations = [];
// Unverified decoding is allowed only where the key cannot be known before reading
// the token: client authentication has to read `iss` to find the agent's registered
// public key, and the audit logger records identifiers from a token it does not own.
// Both re-check every claim they use after the signature verifies.
const allowedUnverified = new Set([
  'apps/agent-op/src/logging/token-metadata.ts',
  'apps/agent-op/src/middleware/client-assertion.ts',
]);
async function walk(path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.ts')) {
      const rel = relative(root, full);
      const source = await readFile(full, 'utf8');
      if (/\bverifyJwtInternal\s*\(/.test(source)) violations.push(`${rel}: verifyJwtInternal is private`);
      if (/\bdecodeJwsUnverified\s*\(/.test(source) && !allowedUnverified.has(rel)) violations.push(`${rel}: unverified decoding is forbidden`);
    }
  }
}
for (const app of await readdir(join(root, 'apps'), { withFileTypes: true })) {
  if (!app.isDirectory()) continue;
  await walk(join(root, 'apps', app.name, 'src/routes'));
  await walk(join(root, 'apps', app.name, 'src/middleware'));
}
for (const violation of violations) console.error(violation);
if (violations.length) process.exit(1);
