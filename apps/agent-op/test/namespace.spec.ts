import { describe, expect, it } from 'vitest';
import { AGENT_URN_PREFIX, isAgentId } from '@xaa/contracts';
import { assertDistinctIdentities, NamespaceViolation } from '../src/idjag/verify-namespace.js';
import { createFixture, exchange, newAgentId, subjectToken } from './helpers.js';

const AGENT = 'agent-abcdefghijklmnopqrstuvwxyz';

describe('identity namespaces stay disjoint', () => {
  it('rejects an actor whose agent id equals the human subject', () => {
    expect(() => assertDistinctIdentities(AGENT, `${AGENT_URN_PREFIX}${AGENT}`)).toThrow(NamespaceViolation);
  });

  it('rejects a human_subject that starts with agent-', () => {
    expect(() => assertDistinctIdentities('agent-someone', `${AGENT_URN_PREFIX}${AGENT}`)).toThrow(NamespaceViolation);
  });

  it('accepts an ordinary human subject', () => {
    expect(() => assertDistinctIdentities('user-1', `${AGENT_URN_PREFIX}${AGENT}`)).not.toThrow();
  });

  it('reports a namespace violation as invalid_request, not invalid_grant', () => {
    try {
      assertDistinctIdentities(AGENT, `${AGENT_URN_PREFIX}${AGENT}`);
      expect.unreachable();
    } catch (error) {
      expect((error as NamespaceViolation).code).toBe('invalid_request');
    }
  });

  it('isAgentId rejects agent_001 and user-123', () => {
    expect(isAgentId('agent_001')).toBe(false);
    expect(isAgentId('user-123')).toBe(false);
    expect(isAgentId(AGENT)).toBe(true);
  });

  it('compares exactly, never by prefix or substring', () => {
    // A human subject that merely contains the agent id is a different identity and
    // must pass; only exact equality is a collision.
    expect(() => assertDistinctIdentities(`user-${AGENT}`, `${AGENT_URN_PREFIX}${AGENT}`)).not.toThrow();
    expect(() => assertDistinctIdentities(AGENT.slice(0, -1), `${AGENT_URN_PREFIX}${AGENT}`)).toThrow(NamespaceViolation);
  });

  it('rejects act.sub equal to sub with invalid_request', async () => {
    // A human whose subject is the agent id itself: namespaces must stay disjoint, and
    // the collision is a malformed request rather than a failed delegation.
    const agentId = newAgentId();
    const fixture = await createFixture({ registration: { agent_id: agentId, human_subject: agentId } });
    const response = await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: agentId }) } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });
});
