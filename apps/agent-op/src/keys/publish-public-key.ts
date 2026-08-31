export interface BucketWriter {
  bucket(name: string): {
    file(path: string): {
      save(body: string, options?: { preconditionOpts?: { ifGenerationMatch?: number }; contentType?: string }): Promise<unknown>;
      download(): Promise<[Buffer]>;
      getMetadata(): Promise<[{ generation?: string | number | null }, ...unknown[]]>;
    };
  };
}

const MAX_ATTEMPTS = 3;

/**
 * REQ-08-017 / DEC-IAC-13. Each service writes only its own `keys/<kid>.json`; the
 * aggregated `jwks.json` is produced by the jwks-publish job. Writing the aggregate
 * from an application is how one service ends up deleting another's kid, so this
 * function cannot address that object at all.
 *
 * Creation is attempted with ifGenerationMatch: 0. A 409 means someone got there
 * first — identical content is success, different content is overwritten against the
 * generation actually present.
 */
export async function publishPublicKey(options: {
  storage: BucketWriter;
  bucket: string;
  kid: string;
  publicJwk: JsonWebKey;
}): Promise<void> {
  const path = `keys/${options.kid}.json`;
  const body = JSON.stringify({ ...options.publicJwk, kid: options.kid, alg: 'ES256', use: 'sig' });
  const file = options.storage.bucket(options.bucket).file(path);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await file.save(body, { preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'application/json' });
      return;
    } catch (error) {
      if (!isPreconditionFailure(error) || attempt === MAX_ATTEMPTS) {
        if (attempt === MAX_ATTEMPTS) throw error;
        throw error;
      }
      const [existing] = await file.download();
      if (existing.toString('utf8') === body) return;
      const [metadata] = await file.getMetadata();
      await file.save(body, { preconditionOpts: { ifGenerationMatch: Number(metadata.generation ?? 0) }, contentType: 'application/json' });
      return;
    }
  }
}

function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 412 || code === 409 || code === '412' || code === '409';
}
