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

  const rows = (name: string, filters: Filter[], limit?: number) => {
    const compare = (actual: unknown, operator: string, value: unknown): boolean => {
      if (operator === '==') return actual === value;
      if (operator === '>=') return String(actual) >= String(value);
      if (operator === '<') return String(actual) < String(value);
      return false;
    };
    const matched = [...documentsOf(name)]
      .filter(([, data]) => filters.every((filter) => compare(data[filter.field], filter.operator, filter.value)))
      .map(([id, data]) => ({ id, data: () => data, ref: docRef(name, id) }));
    return limit === undefined ? matched : matched.slice(0, limit);
  };

  const docRef = (name: string, id: string) => ({
    id,
    __collection: name,
    async get() {
      const data = documentsOf(name).get(id);
      return { exists: data !== undefined, id, data: () => data };
    },
    async set(value: Record<string, unknown>) { documentsOf(name).set(id, value); },
    async create(value: Record<string, unknown>) {
      if (documentsOf(name).has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      documentsOf(name).set(id, value);
    },
    async update(patch: Record<string, unknown>) {
      const current = documentsOf(name).get(id);
      if (!current) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      documentsOf(name).set(id, { ...current, ...patch });
    },
    async delete() { documentsOf(name).delete(id); },
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
    // Sequential rather than optimistic: the double is single-threaded, so a body
    // that reads then writes already sees a consistent snapshot.
    async runTransaction<T>(body: (tx: unknown) => Promise<T>): Promise<T> {
      const writes: Array<() => Promise<void>> = [];
      const result = await body({
        async get(target: { get(): Promise<unknown> }) { return target.get(); },
        set(ref: { __collection: string; id: string }, value: Record<string, unknown>) {
          writes.push(async () => { await docRef(ref.__collection, ref.id).set(value); });
        },
        update(ref: { __collection: string; id: string }, patch: Record<string, unknown>) {
          writes.push(async () => { await docRef(ref.__collection, ref.id).update(patch); });
        },
        delete(ref: { __collection: string; id: string }) {
          writes.push(async () => { await docRef(ref.__collection, ref.id).delete(); });
        },
      });
      for (const write of writes) await write();
      return result;
    },
  };
  return firestore as unknown as Firestore;
}

export async function firestoreUnderTest(): Promise<{ firestore: Firestore; label: string }> {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const { Firestore } = await import('@google-cloud/firestore');
    return { firestore: new Firestore({ projectId: 'xaa-test', databaseId: 'xaa' }), label: 'emulator' };
  }
  return { firestore: createFirestoreDouble(), label: 'double' };
}

export { Timestamp };
