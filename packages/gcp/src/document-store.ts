import { FieldPath, Firestore, Timestamp } from '@google-cloud/firestore';
import { assertPath, type FirestoreAccessMode } from './firestore-guard.js';

/**
 * The data-access surface every application uses. `@google-cloud/firestore` is
 * imported here and nowhere else (DEC-APP-08), and every call runs through the
 * shared access matrix, so an app cannot reach another app's collection even by
 * accident (DEV-05 stands in for the logical database separation of docs 08 §7.1).
 */
export interface DocumentStore {
  get<T = Record<string, unknown>>(collection: string, id: string): Promise<T | undefined>;
  set(collection: string, id: string, data: Record<string, unknown>): Promise<void>;
  /** Rejects when the document already exists; use for atomic claim operations. */
  create(collection: string, id: string, data: Record<string, unknown>): Promise<void>;
  update(collection: string, id: string, patch: Record<string, unknown>): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  /** Half-open range on one field: `gte <= field < lt`. */
  queryRange<T = Record<string, unknown>>(collection: string, field: string, gte: string, lt: string): Promise<Array<{ id: string; data: T }>>;
  queryEqual<T = Record<string, unknown>>(collection: string, filters: Array<[string, unknown]>, limit?: number): Promise<Array<{ id: string; data: T }>>;
  listAll<T = Record<string, unknown>>(collection: string): Promise<Array<{ id: string; data: T }>>;
  updateMany(collection: string, ids: readonly string[], patch: Record<string, unknown>): Promise<number>;
  /** Runs `body` inside a Firestore transaction; reads inside it see a consistent snapshot. */
  transaction<T>(body: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
  expiryFromNow(ttlSeconds: number, now?: number): unknown;
  toMillis(value: unknown): number | null;
}

export interface DocumentTransaction {
  get<T = Record<string, unknown>>(collection: string, id: string): Promise<T | undefined>;
  /** A transactional query: the rows it returns are part of the transaction's snapshot. */
  queryEqual<T = Record<string, unknown>>(collection: string, filters: Array<[string, unknown]>): Promise<Array<{ id: string; data: T }>>;
  count(collection: string, filters: Array<[string, unknown]>): Promise<number>;
  set(collection: string, id: string, data: Record<string, unknown>): void;
  update(collection: string, id: string, patch: Record<string, unknown>): void;
  delete(collection: string, id: string): void;
}

const MAX_BATCH = 500;

export function createFirestoreDocumentStore(firestore: Firestore, app: string): DocumentStore {
  /**
   * The access matrix is written in the logical form of 00b §3, where a sub-document
   * reads `agents/{agent_id}/meta`. Firestore paths must alternate collection and
   * document, so a sub-document is stored flat as `agents/{agent_id}__meta` and the
   * `__` is expanded back to `/` before the matrix is consulted. Physical layout and
   * documented path therefore stay in step.
   */
  const logicalPath = (collection: string, id: string) => `${collection}/${id.replaceAll('__', '/')}`;
  const guard = (mode: FirestoreAccessMode, collection: string, id: string) => {
    assertPath(app, mode, logicalPath(collection, id));
    return firestore.collection(collection).doc(id);
  };
  const guardCollection = (mode: FirestoreAccessMode, collection: string) => {
    assertPath(app, mode, `${collection}/_`);
    return firestore.collection(collection);
  };

  return {
    async get(collection, id) {
      const snapshot = await guard('read', collection, id).get();
      return snapshot.exists ? (snapshot.data() as never) : undefined;
    },
    async set(collection, id, data) { await guard('write', collection, id).set(data); },
    async create(collection, id, data) { await guard('write', collection, id).create(data); },
    async update(collection, id, patch) { await guard('write', collection, id).update(patch); },
    async delete(collection, id) { await guard('delete', collection, id).delete(); },

    async queryRange(collection, field, gte, lt) {
      const snapshot = await guardCollection('read', collection).where(field, '>=', gte).where(field, '<', lt).get();
      return snapshot.docs.map((document) => ({ id: document.id, data: document.data() as never }));
    },
    async queryEqual(collection, filters, limit) {
      let query = guardCollection('read', collection) as FirebaseFirestore.Query;
      for (const [field, value] of filters) query = query.where(field, '==', value);
      if (limit !== undefined) query = query.limit(limit);
      const snapshot = await query.get();
      return snapshot.docs.map((document) => ({ id: document.id, data: document.data() as never }));
    },
    async listAll(collection) {
      const snapshot = await guardCollection('read', collection).get();
      return snapshot.docs.map((document) => ({ id: document.id, data: document.data() as never }));
    },

    async updateMany(collection, ids, patch) {
      const reference = guardCollection('write', collection);
      for (let offset = 0; offset < ids.length; offset += MAX_BATCH) {
        const batch = firestore.batch();
        for (const id of ids.slice(offset, offset + MAX_BATCH)) batch.update(reference.doc(id), patch);
        await batch.commit();
      }
      return ids.length;
    },

    async transaction(body) {
      return firestore.runTransaction(async (tx) => body({
        async get(collection, id) {
          const snapshot = await tx.get(guard('read', collection, id));
          return snapshot.exists ? (snapshot.data() as never) : undefined;
        },
        async queryEqual(collection, filters) {
          let query = guardCollection('read', collection) as FirebaseFirestore.Query;
          for (const [field, value] of filters) query = query.where(field, '==', value);
          const snapshot = await tx.get(query);
          return snapshot.docs.map((document) => ({ id: document.id, data: document.data() as never }));
        },
        async count(collection, filters) {
          let query = guardCollection('read', collection) as FirebaseFirestore.Query;
          for (const [field, value] of filters) query = query.where(field, '==', value);
          const snapshot = await tx.get(query.select(FieldPath.documentId()));
          return snapshot.size;
        },
        set(collection, id, data) { tx.set(guard('write', collection, id), data); },
        update(collection, id, patch) { tx.update(guard('write', collection, id), patch); },
        delete(collection, id) { tx.delete(guard('delete', collection, id)); },
      }));
    },

    expiryFromNow(ttlSeconds, now = Date.now()) { return Timestamp.fromMillis(now + ttlSeconds * 1000); },
    toMillis(value) {
      if (value instanceof Timestamp) return value.toMillis();
      if (typeof value === 'number') return value;
      if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
      return null;
    },
  };
}
