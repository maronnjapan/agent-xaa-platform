import { randomUUID } from 'node:crypto';
import { compile, documentSchema, type StoredDocument } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

const assertDocument: (value: unknown) => asserts value is StoredDocument = compile<StoredDocument>(documentSchema);

export class VersionConflict extends Error {
  constructor() { super('version_conflict'); }
}

export interface DocumentQuery {
  ownerSubject: string;
  type?: string;
  from?: string;
  to?: string;
  limit: number;
}

/** The list projection: the body is deliberately absent (specs §5.1). */
export type DocumentSummary = Pick<StoredDocument, 'document_id' | 'type' | 'title' | 'occurred_at'>;

export function createDocumentRepository(store: DocumentStore, now: () => number = () => Date.now()) {
  return {
    async list(query: DocumentQuery): Promise<DocumentSummary[]> {
      const rows = await store.queryEqual<StoredDocument>('documents', [['owner_subject', query.ownerSubject]]);
      return rows
        .map(({ data }) => data)
        .filter((document) => (query.type === undefined || document.type === query.type)
          && (query.from === undefined || document.occurred_at >= query.from)
          && (query.to === undefined || document.occurred_at <= query.to))
        .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
        .slice(0, query.limit)
        .map(({ document_id, type, title, occurred_at }) => ({ document_id, type, title, occurred_at }));
    },

    /** Returns undefined for another owner's document, so existence is not leaked. */
    async get(documentId: string, ownerSubject: string): Promise<StoredDocument | undefined> {
      const document = await store.get<StoredDocument>('documents', documentId);
      return document && document.owner_subject === ownerSubject ? document : undefined;
    },

    async create(input: { ownerSubject: string; type: string; title: string; body: string; occurredAt: string; metadata?: Record<string, unknown> }): Promise<string> {
      const timestamp = new Date(now()).toISOString();
      const document = {
        document_id: `doc_${randomUUID()}`,
        // The owner is the token subject. A body field of the same name never
        // reaches here: the create schema does not define it.
        owner_subject: input.ownerSubject,
        type: input.type,
        title: input.title,
        body: input.body,
        occurred_at: input.occurredAt,
        metadata: input.metadata ?? {},
        created_at: timestamp,
        updated_at: timestamp,
        version: 1,
      };
      assertDocument(document);
      await store.set('documents', document.document_id, { ...document });
      return document.document_id;
    },

    /**
     * Optimistic locking inside one transaction: the read and the write cannot be
     * split by a concurrent update.
     */
    async update(documentId: string, ownerSubject: string, patch: { version: number; title?: string; body?: string }): Promise<StoredDocument | undefined> {
      return store.transaction(async (tx) => {
        const current = await tx.get<StoredDocument>('documents', documentId);
        if (!current || current.owner_subject !== ownerSubject) return undefined;
        if (current.version !== patch.version) throw new VersionConflict();
        const next: StoredDocument = {
          ...current,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.body === undefined ? {} : { body: patch.body }),
          updated_at: new Date(now()).toISOString(),
          version: current.version + 1,
        };
        tx.set('documents', documentId, { ...next });
        return next;
      });
    },
  };
}
