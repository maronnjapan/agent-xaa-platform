import { Storage } from '@google-cloud/storage';

export interface JwksEntry { jwk: Record<string, unknown> & { kid: string }; updated: number }
const ALLOWED_KID = /^(idp-|op-shared-|idjag-[0-9a-z]{12}-|docs-as-|fin-as-)/;

export function mergeJwksEntries(entries: JwksEntry[]): { keys: Array<Record<string, unknown>>; skipped: number } {
  const selected = new Map<string, JwksEntry>();
  let skipped = 0;
  for (const entry of entries) {
    if (!ALLOWED_KID.test(entry.jwk.kid)) { skipped += 1; continue; }
    const previous = selected.get(entry.jwk.kid);
    if (!previous || previous.updated < entry.updated) selected.set(entry.jwk.kid, entry);
  }
  return { keys: [...selected.values()].sort((a, b) => a.jwk.kid.localeCompare(b.jwk.kid)).map((entry) => entry.jwk), skipped };
}

export async function publishJwks(bucketName: string, storage = new Storage()): Promise<void> {
  const bucket = storage.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: 'keys/' });
  const entries: JwksEntry[] = [];
  for (const file of files) {
    const [content] = await file.download();
    const [metadata] = await file.getMetadata();
    const parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown> & { kid: string };
    entries.push({ jwk: parsed, updated: Date.parse(metadata.updated ?? '1970-01-01') });
  }
  const merged = mergeJwksEntries(entries);
  console.log(JSON.stringify({ skipped: merged.skipped, published: merged.keys.length }));
  await bucket.file('jwks.json').save(JSON.stringify({ keys: merged.keys }), { contentType: 'application/json' });
}
