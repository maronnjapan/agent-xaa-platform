import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { readPendingInstructions } from '@xaa/agent-runtime/src/instructions/read-pending';
import { createRuntimeStore } from '@xaa/agent-runtime/src/store/runtime-store';
import { startAutomationAppHarness } from '../../harness/automation-app.js';

const AGENT_ID = 'agent-abcdefghijklmnopqrstuvwxyz';

/**
 * 「指示を追加する」, from the button to the model's turn.
 *
 * Both sides of `agent_instructions` had unit tests and both were green: the Automation
 * App wrote the words as `text`, the Runtime read a field it called `body`, and each
 * suite seeded rows in its own shape. Nothing failed. The row was found, it was stamped
 * applied so it could never be read again, and the instruction reached the model as a
 * turn with no words in it — so the one channel that can tell an agent what to do
 * delivered nothing, every time.
 *
 * The assertion is on the words, not on the count. A test that only counted the rows is
 * exactly the test that missed this.
 */
describe('an instruction, written by the app and read by the runtime', () => {
  it('arrives at the reasoning loop with the words the person typed', async () => {
    const shared = createFirestoreDouble();
    const automation = await startAutomationAppHarness({ shared });
    const text = '未払いの請求書を確認しておいてください';

    await automation.provisionerStore.set('agents', `${AGENT_ID}__meta`, {
      agent_id: AGENT_ID, human_subject: automation.humanSubject, status: 'ACTIVE',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await automation.runtimeStore.set('agents', `${AGENT_ID}__state`, { agent_status: 'ACTIVE' });

    const posted = await automation.fetch(`/api/agents/${AGENT_ID}/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    expect(posted.status).toBe(201);

    const store = createRuntimeStore({
      documents: createFirestoreDocumentStore(shared, 'agent-runtime'),
      agentId: AGENT_ID,
    });
    const applied = await readPendingInstructions(store, new Date().toISOString());

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ role: 'user', source: 'instruction', text });
    // What the loop puts in front of the model is this object, serialised. The words
    // have to survive that, which is the whole point of the round trip.
    expect(JSON.stringify(applied)).toContain(text);

    // And it is applied exactly once: a second step must not replay it.
    expect(await readPendingInstructions(store, new Date().toISOString())).toEqual([]);
  });
});
