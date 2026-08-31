import { createHash } from 'node:crypto';
import { compile, toolManifestSchema, type ToolManifest } from '@xaa/contracts';

export type ToolDefinition = ToolManifest['tools'][number];

export class ManifestIntegrityError extends Error {
  readonly code = 'manifest_integrity_error';
}

const assertManifest: (value: unknown) => asserts value is ToolManifest = compile<ToolManifest>(toolManifestSchema);

export function manifestSha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * The manifest is read once, checked against its hash, and frozen.
 *
 * REQ-04-018: an agent's permissions are fixed at provisioning time. That is only
 * true if the Runtime cannot fetch a new manifest — so there is no reload function
 * here, no Firestore read, and no Provisioner call. The freeze closes the last gap:
 * a later step cannot push a tool onto `tools` even by accident.
 *
 * The hash is taken over the raw string, before parsing. Comparing parsed objects
 * would let a re-serialisation with different key order pass as identical.
 */
export function loadToolManifest(env: { TOOL_MANIFEST: string; TOOL_MANIFEST_SHA256: string }): ToolManifest {
  const actual = manifestSha256(env.TOOL_MANIFEST);
  if (actual !== env.TOOL_MANIFEST_SHA256) throw new ManifestIntegrityError('tool manifest sha256 mismatch');
  let parsed: unknown;
  try { parsed = JSON.parse(env.TOOL_MANIFEST); } catch { throw new ManifestIntegrityError('tool manifest is not JSON'); }
  assertManifest(parsed);
  return deepFreeze(parsed);
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
