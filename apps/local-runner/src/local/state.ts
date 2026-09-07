import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectStore } from '@xaa/human-idp/src/keys/self-bootstrap';
import { Timestamp, type FirestoreSnapshot } from '@xaa/gcp';
import { createLocalObjectStore } from './object-store.js';

/** Bumped when the shape below changes; a file from an older one is discarded. */
export const STATE_FORMAT_VERSION = 1;

const ROWS_FILE = 'firestore.json';
const KEY_FILE = 'kms-master.key';
const BUCKET_DIRECTORY = 'platform-config';

/** How long a burst of writes is allowed to run before the rows are written down. */
const SAVE_DEBOUNCE_MS = 200;

export interface LocalState {
  /** Where the state is kept, or undefined when this run keeps none. */
  directory: string | undefined;
  /** Nothing was carried over: either the state is new, or there is no state at all. */
  fresh: boolean;
  /** The rows a previous run left, or undefined when there are none to load. */
  rows: FirestoreSnapshot | undefined;
  /** The secret the local KMS derives every key from. */
  kmsMasterSecret: Buffer;
  /** The platform config bucket, for objects an application writes and reads back. */
  objects: ObjectStore;
  /** Records that the rows changed. Writing them down is deferred and coalesced. */
  save(read: () => FirestoreSnapshot): void;
  /** Writes down anything still pending. Called on the way out. */
  flush(): void;
}

interface StateFile {
  version: number;
  updated_at: string;
  collections: FirestoreSnapshot;
}

/**
 * The state of a local run, kept nowhere.
 *
 * This is what the platform did before it could persist anything, and it is still what
 * `LOCAL_PERSIST=false` asks for: a fresh key, an empty database, and nothing left on
 * the machine when the process ends.
 */
export function createEphemeralState(): LocalState {
  return {
    directory: undefined,
    fresh: true,
    rows: undefined,
    kmsMasterSecret: randomBytes(32),
    objects: createLocalObjectStore(),
    save() { /* nowhere to save to */ },
    flush() { /* nothing is pending */ },
  };
}

/**
 * The state of a local run, kept in one directory.
 *
 * Three things have to survive a restart for a restarted platform to be the same
 * platform: the rows, the key the rows were encrypted with, and the objects an
 * application bootstrapped itself from. Keeping only the first would give back a ToDo
 * list beside an IdP connection nobody can decrypt and a login nobody can verify —
 * a database that loaded but a platform that did not.
 *
 * The directory is 0700 and every file in it 0600, because what is in it is what the
 * deployed platform keeps in Cloud KMS and a private bucket. It is disposable by
 * design: deleting it is how a person starts over, and the next run seeds itself again.
 */
export function openLocalState(directory: string): LocalState {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rows = readRows(join(directory, ROWS_FILE));

  const state: LocalState = {
    directory,
    // Nothing came back is what `fresh` means, and a file this version could not read
    // is one of the ways nothing comes back — the platform seeds itself rather than
    // starting empty on top of a file it did not understand.
    fresh: rows === undefined,
    rows,
    kmsMasterSecret: readOrCreateSecret(join(directory, KEY_FILE)),
    objects: createLocalObjectStore(join(directory, BUCKET_DIRECTORY)),
    save() { /* replaced below */ },
    flush() { /* replaced below */ },
  };

  // A write per row would put the whole database on disk once per field update, and a
  // platform that starts an agent writes a great many rows in a few seconds. The rows
  // are rendered and written when the burst stops instead, and on the way out.
  let pending: (() => FirestoreSnapshot) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const writeNow = (): void => {
    const read = pending;
    pending = undefined;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!read) return;
    writeRows(join(directory, ROWS_FILE), read());
  };

  state.save = (read) => {
    pending = read;
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; writeNow(); }, SAVE_DEBOUNCE_MS);
    // Not a reason to keep the process alive: a pending save is flushed on the way out.
    timer.unref();
  };
  state.flush = writeNow;
  return state;
}

/**
 * The rows a previous run left, or nothing at all.
 *
 * A file this version cannot read is discarded rather than repaired. It holds a demo
 * platform's ToDos and documents, all of which the seed and a few minutes of clicking
 * can produce again, and the alternative — a half-understood file loaded into a
 * platform that then behaves oddly — is worse than starting over.
 */
function readRows(file: string): FirestoreSnapshot | undefined {
  let parsed: StateFile;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as StateFile;
  } catch {
    return undefined;
  }
  if (parsed?.version !== STATE_FORMAT_VERSION || typeof parsed.collections !== 'object') return undefined;
  return decode(parsed.collections) as FirestoreSnapshot;
}

function writeRows(file: string, collections: FirestoreSnapshot): void {
  const body: StateFile = {
    version: STATE_FORMAT_VERSION,
    updated_at: new Date().toISOString(),
    collections: encode(collections) as FirestoreSnapshot,
  };
  // Written beside the real file and moved onto it, so a process killed mid-write
  // leaves the previous state rather than half of the next one.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function readOrCreateSecret(file: string): Buffer {
  try {
    const secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (secret.length === 32) return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const created = randomBytes(32);
  writeFileSync(file, `${created.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600 });
  return created;
}

/**
 * The two Firestore values JSON has no shape for.
 *
 * A `Timestamp` written back as `{_seconds, _nanoseconds}` reads as an ordinary object,
 * and `expireAt` comparisons across the platform stop meaning anything: every stored
 * token would look unexpired forever. Bytes have the same problem in a different form.
 * Both are tagged on the way out and rebuilt on the way in, so what a service reads
 * after a restart is what it wrote before one.
 */
const TIMESTAMP_TAG = '$timestamp';
const BYTES_TAG = '$bytes';

export function encode(value: unknown): unknown {
  if (value instanceof Timestamp) return { [TIMESTAMP_TAG]: [value.seconds, value.nanoseconds] };
  if (value instanceof Uint8Array) return { [BYTES_TAG]: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === 'object') {
    const tagged = value as Record<string, unknown>;
    const timestamp = tagged[TIMESTAMP_TAG];
    if (Array.isArray(timestamp)) return new Timestamp(Number(timestamp[0]), Number(timestamp[1]));
    const bytes = tagged[BYTES_TAG];
    if (typeof bytes === 'string') return Buffer.from(bytes, 'base64');
    return Object.fromEntries(Object.entries(tagged).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}
