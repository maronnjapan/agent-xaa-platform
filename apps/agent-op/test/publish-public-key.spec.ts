import { describe, expect, it } from 'vitest';
import { publishPublicKey, type BucketWriter } from '../src/keys/publish-public-key.js';

interface Written { path: string; body: string; generation?: number }

function bucketDouble(options: { existing?: string; failCreate?: boolean; alwaysFail?: boolean } = {}) {
  const writes: Written[] = [];
  let stored = options.existing;
  const storage: BucketWriter = {
    bucket: () => ({
      file: (path: string) => ({
        async save(body: string, saveOptions?: { preconditionOpts?: { ifGenerationMatch?: number } }) {
          if (options.alwaysFail) throw Object.assign(new Error('nope'), { code: 500 });
          const generation = saveOptions?.preconditionOpts?.ifGenerationMatch;
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
  return { storage, writes };
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
});
