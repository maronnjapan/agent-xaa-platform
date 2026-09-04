import { Timestamp, type Firestore } from '@google-cloud/firestore';

/**
 * In-process stand-in for the Firestore surface `DocumentStore` and the two store
 * implementations use: document get/set/create/update/delete, equality and
 * half-open range queries, batched writes and transactions.
 *
 * It exists so the same specs run with or without `gcloud emulators firestore`.
 * Set FIRESTORE_EMULATOR_HOST to exercise the real client instead.
 */
export function createFirestoreDouble(): Firestore {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const documentsOf = (name: string) => {
    const existing = collections.get(name);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    collections.set(name, created);
    return created;
  };

  interface Filter { field: string; operator: string; value: unknown }

  // Bumped on every write so a transaction can tell whether what it read still holds.
  const versions = new Map<string, number>();
  const versionOf = (name: string, id: string) => versions.get(`${name}/${id}`) ?? 0;
  const bump = (name: string, id: string) => versions.set(`${name}/${id}`, versionOf(name, id) + 1);

  const rows = (name: string, filters: Filter[], limit?: number) => {
    const compare = (actual: unknown, operator: string, value: unknown): boolean => {
      if (operator === '==') return actual === value;
      if (operator === '>=') return String(actual) >= String(value);
      if (operator === '<') return String(actual) < String(value);
      return false;
    };
    const matched = [...documentsOf(name)]
      .filter(([, data]) => filters.every((filter) => compare(data[filter.field], filter.operator, filter.value)))
      .map(([id, data]) => ({ id, __collection: name, data: () => data, ref: docRef(name, id) }));
    return limit === undefined ? matched : matched.slice(0, limit);
  };

  const docRef = (name: string, id: string) => ({
    id,
    __collection: name,
    async get() {
      const data = documentsOf(name).get(id);
      return { exists: data !== undefined, id, __collection: name, data: () => data };
    },
    async set(value: Record<string, unknown>) { documentsOf(name).set(id, value); bump(name, id); },
    async create(value: Record<string, unknown>) {
      if (documentsOf(name).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      documentsOf(name).set(id, value);
      bump(name, id);
    },
    async update(patch: Record<string, unknown>) {
      const current = documentsOf(name).get(id);
      if (!current) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      documentsOf(name).set(id, { ...current, ...patch });
      bump(name, id);
    },
    async delete() { documentsOf(name).delete(id); bump(name, id); },
  });

  const query = (name: string, filters: Filter[] = [], limit?: number): unknown => ({
    doc: (id: string) => docRef(name, id),
    where: (field: string, operator: string, value: unknown) => query(name, [...filters, { field, operator, value }], limit),
    limit: (count: number) => query(name, filters, count),
    select: () => query(name, filters, limit),
    async get() {
      const docs = rows(name, filters, limit);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });

  const firestore = {
    collection: (name: string) => query(name),
    batch() {
      const operations: Array<() => Promise<void>> = [];
      return {
        update(ref: { __collection: string; id: string }, patch: Record<string, unknown>) {
          operations.push(async () => { await docRef(ref.__collection, ref.id).update(patch); });
        },
        set(ref: { __collection: string; id: string }, value: Record<string, unknown>) {
          operations.push(async () => { await docRef(ref.__collection, ref.id).set(value); });
        },
        delete(ref: { __collection: string; id: string }) {
          operations.push(async () => { await docRef(ref.__collection, ref.id).delete(); });
        },
        async commit() { for (const operation of operations) await operation(); },
      };
    },
    /**
     * Optimistic concurrency, the way Firestore does it: a transaction records what it
     * read, and commits only if none of it changed meanwhile — otherwise the body runs
     * again on fresh data.
     *
     * The double could get away with running transactions one after another, since it
     * is single-threaded. It does not, because the specs that matter here are about two
     * readers racing for the same row (T-RUN-22's "an instruction is applied once"), and
     * a double that cannot lose that race would pass a test the real database fails.
     */
    async runTransaction<T>(body: (tx: unknown) => Promise<T>): Promise<T> {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // Synchronous, so the check below and these writes cannot be interleaved with
        // another transaction's — which is what makes the commit atomic here, as it is
        // on the server.
        const writes: Array<() => void> = [];
        const readVersions = new Map<string, number>();
        const observe = (name: string, id: string) => readVersions.set(`${name}/${id}`, versionOf(name, id));
        const result = await body({
          async get(target: { get(): Promise<unknown>; __collection?: string; id?: string }) {
            const snapshot = await target.get() as { docs?: Array<{ id: string; __collection?: string }> };
            if (target.__collection !== undefined && target.id !== undefined) observe(target.__collection, target.id);
            for (const document of snapshot.docs ?? []) observe(document.__collection ?? '', document.id);
            return snapshot;
          },
          set(ref: { __collection: string; id: string }, value: Record<string, unknown>) {
            writes.push(() => { documentsOf(ref.__collection).set(ref.id, value); bump(ref.__collection, ref.id); });
          },
          update(ref: { __collection: string; id: string }, patch: Record<string, unknown>) {
            writes.push(() => {
              const current = documentsOf(ref.__collection).get(ref.id);
              if (!current) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
              documentsOf(ref.__collection).set(ref.id, { ...current, ...patch });
              bump(ref.__collection, ref.id);
            });
          },
          delete(ref: { __collection: string; id: string }) {
            writes.push(() => { documentsOf(ref.__collection).delete(ref.id); bump(ref.__collection, ref.id); });
          },
        });
        const stale = [...readVersions].some(([key, version]) => {
          const [name, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
          return versionOf(name, id) !== version;
        });
        if (stale) continue;
        for (const write of writes) write();
        return result;
      }
      throw Object.assign(new Error('ABORTED: too much contention'), { code: 10 });
    },
  };
  return firestore as unknown as Firestore;
}

export async function firestoreUnderTest(): Promise<{ firestore: Firestore; label: string }> {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const { Firestore } = await import('@google-cloud/firestore');
    return { firestore: new Firestore({ projectId: 'xaa-test', databaseId: 'xaa-db' }), label: 'emulator' };
  }
  return { firestore: createFirestoreDouble(), label: 'double' };
}

export { Timestamp };
