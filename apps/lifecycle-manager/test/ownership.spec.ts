import { describe, expect, it } from 'vitest';
import { assertAgentOwnership, ForbiddenSubject } from '../src/ownership.js';
import { AgentNotFound } from '../src/status-writer.js';
import { createLifecycleHarness, seedDomain } from '../src/testing/harness.js';

/**
 * Whose agent it is, answered before anything else about it.
 *
 * The two refusals are deliberately different. "No such agent" and "not yours" are
 * distinct facts, and REQ-07-025 asks for both: a person who mistypes an id should be
 * told so, and a person probing for someone else's agents learns only that the agent is
 * not theirs. Folding the 403 into a 404 here would hide a real authorization failure
 * from the audit log, which is where it matters most.
 */
describe('ownership', () => {
  it('returns 404 for unknown agent / 403 for other subject', async () => {
    const harness = createLifecycleHarness();
    await seedDomain(harness, { humanSubject: 'someone-else' });
    await expect(assertAgentOwnership({
      documents: harness.documents, agentId: 'agent-missing', subject: 'testuser',
    })).rejects.toThrow(AgentNotFound);
    await expect(assertAgentOwnership({
      documents: harness.documents, agentId: 'agent-abcdefghijklmnopqrstuvwxyz', subject: 'testuser',
    })).rejects.toThrow(ForbiddenSubject);
  });

  it('returns the record for the owner', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness);
    await expect(assertAgentOwnership({ documents: harness.documents, agentId, subject: 'testuser' }))
      .resolves.toMatchObject({ human_subject: 'testuser', status: 'ACTIVE' });
  });
});
