import { describe, expect, it } from 'vitest';
import { createFirestoreDouble, type FirestoreSnapshot } from '../src/testing/firestore-double.js';

/**
 * The double as a database that can be put down and picked up again.
 *
 * Rows in and a notification out are the whole of what the local runner needs to keep a
 * platform's state between two runs, and both halves have to hold for every way the
 * double is written to — a plain `set`, a batch and a transaction alike — or the state
 * on disk would be a subset of the state in memory, silently.
 */
describe('the Firestore double', () => {
  it('starts from the rows it is given', async () => {
    const firestore = createFirestoreDouble({
      snapshot: { work_definitions: { 'wd-1': { title: 'ToDo', status: 'CONFIRMED' } } },
    });
    const document = await firestore.collection('work_definitions').doc('wd-1').get();
    expect(document.exists).toBe(true);
    expect(document.data()).toEqual({ title: 'ToDo', status: 'CONFIRMED' });
  });

  it('hands back every row after a write, whichever way the write was made', async () => {
    let latest: FirestoreSnapshot = {};
    let writes = 0;
    const firestore = createFirestoreDouble({
      onWrite: (read) => { writes += 1; latest = read(); },
    });

    await firestore.collection('agents').doc('agent-1__meta').set({ status: 'ACTIVE' });
    expect(latest).toEqual({ agents: { 'agent-1__meta': { status: 'ACTIVE' } } });

    const batch = firestore.batch();
    batch.set(firestore.collection('documents').doc('doc-1'), { title: 'report' });
    await batch.commit();
    expect(latest.documents).toEqual({ 'doc-1': { title: 'report' } });

    await firestore.runTransaction(async (tx) => {
      tx.update(firestore.collection('agents').doc('agent-1__meta'), { status: 'REVOKED' });
    });
    expect(latest.agents).toEqual({ 'agent-1__meta': { status: 'REVOKED' } });

    await firestore.collection('documents').doc('doc-1').delete();
    expect(latest.documents).toEqual({});
    expect(writes).toBe(4);
  });

  /**
   * The snapshot is rendered by calling `read`, not by being handed one. A caller that
   * coalesces its saves — which the local runner does, or it would write the whole
   * database to disk once per field update — must be able to skip the rendering.
   */
  it('renders the rows only when the caller asks for them', async () => {
    let renders = 0;
    const firestore = createFirestoreDouble({
      onWrite: (read) => {
        renders += 1;
        // Deliberately not called on the first two writes.
        if (renders > 2) read();
      },
    });
    for (const id of ['a', 'b', 'c']) await firestore.collection('documents').doc(id).set({ id });
    expect(renders).toBe(3);
  });

  it('round-trips through a snapshot', async () => {
    let latest: FirestoreSnapshot = {};
    const first = createFirestoreDouble({ onWrite: (read) => { latest = read(); } });
    await first.collection('human_permissions').doc('testuser__document.read').set({
      human_subject: 'testuser', capability_id: 'document.read',
    });

    const second = createFirestoreDouble({ snapshot: latest });
    const rows = await second.collection('human_permissions').where('human_subject', '==', 'testuser').get();
    expect(rows.docs.map((row) => row.id)).toEqual(['testuser__document.read']);
  });
});
