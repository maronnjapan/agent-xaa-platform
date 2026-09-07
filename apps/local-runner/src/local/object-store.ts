import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import type { ObjectStore } from '@xaa/human-idp/src/keys/self-bootstrap';

/**
 * A Cloud Storage bucket, as a directory or as a map.
 *
 * The platform config bucket holds objects an application wrote and expects to read
 * back on its next cold start — the Human IdP's wrapped SSO key above all (DEC-ID-17).
 * `bootstrapSigningKey` is written against this interface rather than against Storage
 * precisely so the thing underneath it can be something else, and here it is either a
 * directory under the state directory or, when the run keeps no state, a map that dies
 * with the process.
 *
 * `createIfAbsent` raises a 412-shaped error, which is what Cloud Storage's
 * `ifGenerationMatch: 0` precondition raises and what `isPreconditionFailed` reads. A
 * store whose creation quietly overwrote would turn two cold starts racing for the
 * first key into two different keys, one of which nobody can verify against.
 */
export function createLocalObjectStore(directory?: string): ObjectStore {
  const memory = new Map<string, string>();
  if (directory === undefined) {
    return {
      async read(path) { return memory.get(path) ?? null; },
      async createIfAbsent(path, body) {
        if (memory.has(path)) throw Object.assign(new Error('PRECONDITION_FAILED'), { code: 412 });
        memory.set(path, body);
      },
      async write(path, body) { memory.set(path, body); },
    };
  }

  /**
   * An object name is a path inside the bucket and nothing more: a `..` in it would
   * reach out of the state directory, and the caller of a bucket has no business
   * naming a file next to it.
   */
  const fileFor = (path: string): string => {
    const relative = normalize(path);
    if (relative.startsWith('..') || relative.startsWith(sep)) throw new Error(`invalid object name: ${path}`);
    return join(directory, relative);
  };

  return {
    async read(path) {
      try {
        return readFileSync(fileFor(path), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async createIfAbsent(path, body) {
      const file = fileFor(path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try {
        // `wx` is the precondition: the write fails rather than replacing what is there.
        writeFileSync(file, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw Object.assign(new Error('PRECONDITION_FAILED'), { code: 412 });
      }
    },
    async write(path, body) {
      const file = fileFor(path);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    },
  };
}
