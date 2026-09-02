import { describe, expect, it, vi } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble, type DocumentStore } from '@xaa/gcp';
import { permSet, type PermissionChangeMessage } from '../src/perm-set.js';
import { AUTHZ_COLLECTIONS, humanPermissionId } from '../src/store/collections.js';

const CHANGED_AT = Date.parse('2026-03-01T00:00:00.000Z');

/** The command's world: the permission table, the topic, and a fixed clock. */
async function cli(options: { granted?: string[] } = {}) {
  const documents = createFirestoreDocumentStore(createFirestoreDouble(), 'seed');
  for (const capability of options.granted ?? []) {
    await documents.set(AUTHZ_COLLECTIONS.humanPermissions, humanPermissionId('user-123', capability), {
      human_subject: 'user-123', capability_id: capability, granted_at: '2026-02-01T00:00:00.000Z',
    });
  }
  const published: PermissionChangeMessage[] = [];
  const writes = vi.fn();
  const watched: DocumentStore = {
    ...documents,
    set: async (collection, id, data) => { writes(collection, id); await documents.set(collection, id, data); },
    delete: async (collection, id) => { writes(collection, id); await documents.delete(collection, id); },
  };
  const errors: string[] = [];
  return {
    documents, published, writes, errors,
    run: (argv: string[]) => permSet(argv, {
      documents: watched,
      publish: async (message) => { published.push(message); },
      now: () => CHANGED_AT,
      error: (line) => errors.push(line),
    }),
  };
}

/**
 * REQ-03-010. The demo's way of taking a permission away from a person, and the only
 * one: the row disappears and the platform is told, in one command, so a running agent
 * cannot keep an authority its human no longer has (RULE-13).
 */
describe('pnpm perm:set', () => {
  it('revokes the row and announces the change once', async () => {
    const harness = await cli({ granted: ['calendar.event.read', 'calendar.event.write'] });

    expect(await harness.run(['user-123', 'calendar.event.read', 'revoke'])).toBe(0);

    expect(await harness.documents.get(AUTHZ_COLLECTIONS.humanPermissions, 'user-123__calendar.event.read')).toBeUndefined();
    // The person's other permission is untouched.
    expect(await harness.documents.get(AUTHZ_COLLECTIONS.humanPermissions, 'user-123__calendar.event.write')).toBeDefined();
    expect(harness.published).toEqual([{
      human_subject: 'user-123', capability_id: 'calendar.event.read',
      action: 'revoke', changed_at: '2026-03-01T00:00:00.000Z',
    }]);
  });

  it('grants a row that was not there', async () => {
    const harness = await cli();

    expect(await harness.run(['user-123', 'mail.message.send', 'grant'])).toBe(0);

    expect(await harness.documents.get(AUTHZ_COLLECTIONS.humanPermissions, 'user-123__mail.message.send'))
      .toMatchObject({ human_subject: 'user-123', capability_id: 'mail.message.send' });
    expect(harness.published.map((message) => message.action)).toEqual(['grant']);
  });

  /**
   * A refused argument changes nothing and announces nothing. Either half alone is
   * worse than the refusal: a silent write leaves running agents stale, and a silent
   * announcement makes every subscriber re-evaluate against a table nobody changed.
   */
  it('refuses an unknown action, writing nothing and publishing nothing', async () => {
    const harness = await cli({ granted: ['calendar.event.read'] });

    expect(await harness.run(['user-123', 'calendar.event.read', 'delete'])).toBe(1);

    expect(harness.writes).toHaveBeenCalledTimes(0);
    expect(harness.published).toEqual([]);
    expect(await harness.documents.get(AUTHZ_COLLECTIONS.humanPermissions, 'user-123__calendar.event.read')).toBeDefined();
    expect(harness.errors[0]).toContain('delete');
  });

  it('refuses a capability id that breaks the naming rule', async () => {
    const harness = await cli();

    expect(await harness.run(['user-123', 'google.calendar.read', 'grant'])).toBe(1);

    expect(harness.writes).toHaveBeenCalledTimes(0);
    expect(harness.published).toEqual([]);
  });

  it('refuses the wrong number of arguments', async () => {
    const harness = await cli();
    expect(await harness.run(['user-123', 'calendar.event.read'])).toBe(1);
    expect(harness.published).toEqual([]);
  });
});
