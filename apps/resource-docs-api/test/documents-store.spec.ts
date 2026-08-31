import { describe, expect, it } from 'vitest';
import { compile, documentCreateSchema, documentSchema, SchemaValidationError, type StoredDocument } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createDocumentRepository, VersionConflict } from '../src/store/documents.js';

const repository = () => createDocumentRepository(createFirestoreDocumentStore(createFirestoreDouble(), 'resource-docs-api'));
const assertDocument: (value: unknown) => asserts value is StoredDocument = compile<StoredDocument>(documentSchema);
const assertCreate = compile(documentCreateSchema);

const seedInput = { ownerSubject: 'user-1', type: 'daily_report', title: 't', body: 'b', occurredAt: '2026-01-01T00:00:00Z' };

describe('document schema', () => {
  it('rejects an undefined field', () => {
    expect(() => assertCreate({ ...{ type: 'note', title: 't', body: 'b', occurred_at: '2026-01-01T00:00:00Z' }, extra: 1 }))
      .toThrow(SchemaValidationError);
  });

  it('has no owner_subject in the create input', () => {
    expect(Object.keys(documentCreateSchema.properties)).not.toContain('owner_subject');
    expect(() => assertCreate({ type: 'note', title: 't', body: 'b', occurred_at: '2026-01-01T00:00:00Z', owner_subject: 'x' }))
      .toThrow(SchemaValidationError);
  });

  it('rejects a type outside the enum', () => {
    expect(() => assertCreate({ type: 'invoice', title: 't', body: 'b', occurred_at: '2026-01-01T00:00:00Z' }))
      .toThrow(SchemaValidationError);
  });

  it('fixes the stored shape at ten fields', () => {
    expect(documentSchema.required).toHaveLength(10);
  });
});

describe('document repository', () => {
  it('stores the owner from the caller and starts at version 1', async () => {
    const store = repository();
    const id = await store.create(seedInput);
    const document = await store.get(id, 'user-1');
    assertDocument(document);
    expect(document.owner_subject).toBe('user-1');
    expect(document.version).toBe(1);
  });

  it('hides another owner\'s document', async () => {
    const store = repository();
    const id = await store.create(seedInput);
    expect(await store.get(id, 'user-2')).toBeUndefined();
    expect(await store.update(id, 'user-2', { version: 1, title: 'x' })).toBeUndefined();
  });

  it('bumps the version and refuses a stale one', async () => {
    const store = repository();
    const id = await store.create(seedInput);
    const updated = await store.update(id, 'user-1', { version: 1, title: 'renamed' });
    expect(updated!.version).toBe(2);
    expect(updated!.title).toBe('renamed');
    await expect(store.update(id, 'user-1', { version: 1, title: 'again' })).rejects.toBeInstanceOf(VersionConflict);
  });

  it('filters the list by owner, type and time, and drops the body', async () => {
    const store = repository();
    await store.create({ ...seedInput, type: 'note', occurredAt: '2026-01-01T00:00:00Z' });
    await store.create({ ...seedInput, type: 'daily_report', occurredAt: '2026-02-01T00:00:00Z' });
    await store.create({ ...seedInput, ownerSubject: 'user-2' });
    const all = await store.list({ ownerSubject: 'user-1', limit: 20 });
    expect(all).toHaveLength(2);
    for (const summary of all) expect(Object.keys(summary)).not.toContain('body');
    expect(await store.list({ ownerSubject: 'user-1', type: 'note', limit: 20 })).toHaveLength(1);
    expect(await store.list({ ownerSubject: 'user-1', from: '2026-01-15T00:00:00Z', limit: 20 })).toHaveLength(1);
  });

  it('honours the limit', async () => {
    const store = repository();
    for (let index = 0; index < 5; index += 1) await store.create(seedInput);
    expect(await store.list({ ownerSubject: 'user-1', limit: 2 })).toHaveLength(2);
  });
});
