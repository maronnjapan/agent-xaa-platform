import { Storage } from '@google-cloud/storage';

export interface JwksEntry { jwk: Record<string, unknown> & { kid: string }; updated: number }
const ALLOWED_KID = /^(idp-|op-shared-|idjag-[0-9a-z]{12}-|docs-as-|fin-as-)/;

/**
 * The issuer's own signing key, told apart from the four other prefixes.
 *
 * Every Control Plane app — Authorization Platform, Provisioner, Lifecycle Manager —
 * verifies the human Access Token against this aggregate, and the Human IdP is the
 * only thing that signs one. An aggregate without an `idp-` key is therefore not a
 * smaller JWK Set; it is a platform where every call a person makes answers
 * `invalid_token`.
 */
const ISSUER_KID = /^idp-/;

export class IssuerKeyMissing extends Error {
  readonly code = 'issuer_key_missing';
}

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

export interface WaitOptions {
  fetchImpl?: typeof fetch;
  attempts?: number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Asks the Human IdP for its own JWK Set, and keeps asking until it has one.
 *
 * The request is not a health check: it is what makes the key exist. The Human IdP
 * generates its RS256 SSO key on the first request that needs to sign something and
 * writes `keys/<kid>.json` in the same call (apps/human-idp/src/keys/self-bootstrap.ts,
 * DEC-ID-17), so a Cloud Run service scaled to zero that nobody has called yet has
 * published nothing. This job used to read the bucket regardless and publish whatever
 * was there.
 *
 * What that produced was a deployment that looked finished and was not. Logging in
 * still worked, because Automation App verifies the person's tokens against the IdP's
 * own `/.well-known/jwks.json` rather than the aggregate; the first call that crossed
 * a service boundary — 「必要な権限を調べる」 — answered `invalid_token`, which the
 * screen reports as 「権限を判定する仕組みに届きませんでした」. Nothing republished the
 * aggregate afterwards, so waiting did not help either.
 *
 * `scripts/deploy-gcp-guide.sh` polled this endpoint before executing the job. The
 * GitHub Actions deploy (`make seed`) did not, and neither does a person running the
 * Makefile, so the wait belongs to the job rather than to one of its callers.
 */
export async function waitForIssuerJwks(jwksUrl: string, options: WaitOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 24;
  const delayMs = options.delayMs ?? 5_000;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }));
  const log = options.log ?? ((line) => process.stdout.write(line));

  let reason = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(jwksUrl, { redirect: 'error' });
      if (!response.ok) {
        reason = `status ${response.status}`;
      } else {
        const body = await response.json() as { keys?: unknown };
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (keys.length > 0) {
          log(`${JSON.stringify({ issuer_jwks: jwksUrl, keys: keys.length, attempt })}\n`);
          return;
        }
        reason = 'the set is empty';
      }
    } catch (error) {
      reason = String(error);
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new IssuerKeyMissing(`${jwksUrl} served no key after ${attempts} attempts: ${reason}`);
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
  const kids = merged.keys.map((key) => String(key.kid));
  process.stdout.write(`${JSON.stringify({ skipped: merged.skipped, published: merged.keys.length, kids })}\n`);
  // Checked before the write, not after: replacing a good aggregate with one that has
  // lost the issuer's key would take a working platform down, and leaving the previous
  // object in place is the outcome a person can still log in against. A job that fails
  // here is read from the deploy log; a job that succeeds here and publishes an
  // issuer-less set is read from a screen that says the permission service is
  // unreachable, three steps away from the cause.
  if (!kids.some((kid) => ISSUER_KID.test(kid))) {
    throw new IssuerKeyMissing(`gs://${bucketName}/keys/ holds no idp- key; refusing to replace jwks.json`);
  }
  await bucket.file('jwks.json').save(JSON.stringify({ keys: merged.keys }), { contentType: 'application/json' });
}
