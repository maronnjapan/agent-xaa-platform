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
      if (attempt === 1) {
        await file.save(body, { preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'application/json' });
        return;
      }
      const [existing] = await file.download();
      if (existing.toString('utf8') === body) return;
      const [metadata] = await file.getMetadata();
      await file.save(body, { preconditionOpts: { ifGenerationMatch: Number(metadata.generation ?? 0) }, contentType: 'application/json' });
      return;
    } catch (error) {
      // Anything but a lost race is fatal at once; a lost race is worth re-reading,
      // because the generation this attempt wrote against has already moved.
      if (!isPreconditionFailure(error)) throw error;
    }
  }
  throw new Error(`publishPublicKey: ${path} could not be written in ${MAX_ATTEMPTS} attempts`);
}

/**
 * The startup seam. `MODE=callback` never signs an ID-JAG, so it must not publish a
 * signing key — and it holds no KMS permission to read one. The guard lives here
 * rather than at the call site so it is one testable place (T-OP-05).
 */
export async function publishPublicKeyOnStartup(options: {
  mode: 'token' | 'callback';
  storage: BucketWriter;
  bucket: string;
  kid: string;
  readPublicJwk: () => Promise<JsonWebKey>;
}): Promise<void> {
  if (options.mode !== 'token') return;
  await publishPublicKey({
    storage: options.storage, bucket: options.bucket, kid: options.kid,
    publicJwk: await options.readPublicJwk(),
  });
}

function isPreconditionFailure(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return code === 412 || code === 409 || code === '412' || code === '409';
}
