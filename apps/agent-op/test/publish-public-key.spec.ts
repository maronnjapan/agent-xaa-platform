import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { publishPublicKey, publishPublicKeyOnStartup, type BucketWriter } from '../src/keys/publish-public-key.js';

interface Written { path: string; body: string; generation?: number }

function bucketDouble(options: {
  existing?: string; failCreate?: boolean; alwaysFail?: boolean; alwaysConflict?: boolean;
} = {}) {
  const writes: Written[] = [];
  const attempts: string[] = [];
  let stored = options.existing;
  const storage: BucketWriter = {
    bucket: () => ({
      file: (path: string) => ({
        async save(body: string, saveOptions?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
          attempts.push(path);
          if (options.alwaysFail) throw Object.assign(new Error('nope'), { code: 500 });
          const generation = saveOptions?.preconditionOpts?.ifGenerationMatch;
          if (options.alwaysConflict) throw Object.assign(new Error('precondition failed'), { code: 412 });
          if (generation === 0 && (stored !== undefined || options.failCreate)) {
            throw Object.assign(new Error('precondition failed'), { code: 412 });
          }
          stored = body;
          writes.push({ path, body, ...(generation === undefined ? {} : { generation }) });
        },
        async download(): Promise<[Buffer]> { return [Buffer.from(stored ?? '', 'utf8')]; },
        async getMetadata(): Promise<[{ generation?: string | number | null }, ...unknown[]]> { return [{ generation: 7 }]; },
      }),
    }),
  };
  return { storage, writes, attempts };
}

const publicJwk = { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } as JsonWebKey;

describe('publishing the signing public key', () => {
  it('writes only keys/<kid>.json and never jwks.json', async () => {
    const { storage, writes } = bucketDouble();
    await publishPublicKey({ storage, bucket: 'xaa-jwks', kid: 'op-shared-1', publicJwk });
    expect(writes.map((write) => write.path)).toEqual(['keys/op-shared-1.json']);
    expect(writes.some((write) => write.path.includes('jwks.json'))).toBe(false);
    expect(JSON.parse(writes[0]!.body)).toMatchObject({ kid: 'op-shared-1', alg: 'ES256', use: 'sig' });
  });

  it('treats an identical existing object as success', async () => {
    const body = JSON.stringify({ ...publicJwk, kid: 'op-shared-1', alg: 'ES256', use: 'sig' });
    const { storage, writes } = bucketDouble({ existing: body });
    await publishPublicKey({ storage, bucket: 'xaa-jwks', kid: 'op-shared-1', publicJwk });
    expect(writes).toHaveLength(0);
  });

  it('retries with ifGenerationMatch on a conflict and succeeds', async () => {
    const { storage, writes } = bucketDouble({ existing: '{"kid":"stale"}' });
    await publishPublicKey({ storage, bucket: 'xaa-jwks', kid: 'op-shared-1', publicJwk });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.generation).toBe(7);
  });

  it('propagates a failure that is not a precondition conflict', async () => {
    const { storage } = bucketDouble({ alwaysFail: true });
    await expect(publishPublicKey({ storage, bucket: 'xaa-jwks', kid: 'op-shared-1', publicJwk })).rejects.toThrow();
  });

  /**
   * Startup awaits this without a catch, and `server.ts` awaits `createRuntimeDeps` at
   * the top level, so the rejection becomes an unhandled rejection and Node exits
   * non-zero. Issuing grants whose key is missing from the JWK Set is the alternative.
   */
  it('startup exits non-zero when publish fails after 3 retries', async () => {
    const { storage, attempts, writes } = bucketDouble({ alwaysConflict: true });
    await expect(publishPublicKeyOnStartup({
      mode: 'token', storage, bucket: 'xaa-jwks', kid: 'op-shared-1', readPublicJwk: async () => publicJwk,
    })).rejects.toThrow(/3 attempts/);
    expect(attempts).toHaveLength(3);
    expect(writes).toHaveLength(0);

    const runtime = await readFile(new URL('../src/runtime.ts', import.meta.url).pathname, 'utf8');
    expect(runtime).toMatch(/await publishPublicKeyOnStartup\(/);
    expect(runtime).not.toMatch(/publishPublicKeyOnStartup[\s\S]*?\.catch\(/);
    const server = await readFile(new URL('../src/server.ts', import.meta.url).pathname, 'utf8');
    expect(server).toMatch(/await createRuntimeDeps\(\)/);
  });

  it('does not call publishPublicKey when MODE=callback', async () => {
    const { storage, writes, attempts } = bucketDouble();
    let reads = 0;
    const read = async (): Promise<JsonWebKey> => { reads += 1; return publicJwk; };
    await publishPublicKeyOnStartup({ mode: 'callback', storage, bucket: 'xaa-jwks', kid: 'op-shared-1', readPublicJwk: read });
    expect(reads).toBe(0);
    expect(attempts).toHaveLength(0);
    expect(writes).toHaveLength(0);

    // The same call in the token mode does publish, so the assertion above is the
    // mode guard and not an inert double.
    await publishPublicKeyOnStartup({ mode: 'token', storage, bucket: 'xaa-jwks', kid: 'op-shared-1', readPublicJwk: read });
    expect(reads).toBe(1);
    expect(writes.map((write) => write.path)).toEqual(['keys/op-shared-1.json']);
  });
});
