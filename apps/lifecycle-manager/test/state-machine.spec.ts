import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  AGENT_STATUSES, ALLOWED_TRANSITIONS, InvalidTransitionError, transition, type AgentStatus,
} from '../src/state-machine.js';
import { writeStatus, AgentNotFound } from '../src/status-writer.js';
import { assertAgentOwnership, ForbiddenSubject } from '../src/ownership.js';
import { createLifecycleHarness, seedDomain } from '../src/testing/harness.js';

const repoRoot = new URL('../../../', import.meta.url).pathname;

describe('the lifecycle state machine', () => {
  it('covers all 81 pairs', () => {
    let allowed = 0;
    let refused = 0;
    for (const from of AGENT_STATUSES) {
      for (const to of AGENT_STATUSES) {
        try {
          transition(from, to);
          allowed += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidTransitionError);
          refused += 1;
        }
      }
    }
    expect(allowed).toBe(ALLOWED_TRANSITIONS.length);
    expect(allowed).toBe(11);
    expect(refused).toBe(70);
    expect(allowed + refused).toBe(81);
  });

  it('allows ACTIVE to QUARANTINED only with CRITICAL severity', () => {
    expect(() => transition('ACTIVE', 'QUARANTINED')).toThrow(InvalidTransitionError);
    expect(transition('ACTIVE', 'QUARANTINED', { severity: 'CRITICAL' })).toBe('QUARANTINED');
    // The exception is not in the table; nothing else can reach it by looking there.
    expect(ALLOWED_TRANSITIONS.some(([from, to]) => from === 'ACTIVE' && to === 'QUARANTINED')).toBe(false);
  });

  it('rejects backward transitions', () => {
    for (const from of ['QUARANTINED', 'DESTROYED', 'REVOKED'] as AgentStatus[]) {
      expect(() => transition(from, 'ACTIVE')).toThrow(InvalidTransitionError);
    }
  });

  it('rejects a transition to the same state', () => {
    for (const status of AGENT_STATUSES) {
      expect(() => transition(status, status)).toThrow(InvalidTransitionError);
    }
  });

  it('is the only path to a status field', () => {
    expect(() => execFileSync('bash', ['scripts/check-status-write-path.sh'], { cwd: repoRoot })).not.toThrow();
  });
});

describe('writing a status', () => {
  it('records when and why alongside what', async () => {
    const harness = createLifecycleHarness({ now: () => Date.parse('2026-02-01T00:00:00.000Z') });
    const agentId = await seedDomain(harness);
    const moved = await writeStatus({
      documents: harness.documents, agentId, to: 'REVOKED', reason: 'USER_STOP',
      now: Date.parse('2026-02-01T00:00:00.000Z'),
    });
    expect(moved).toEqual({ from: 'ACTIVE', to: 'REVOKED' });
    const meta = await harness.documents.get<{ status: string; status_changed_at: string; status_reason: string }>(
      'agents', `${agentId}__meta`,
    );
    expect(meta).toMatchObject({
      status: 'REVOKED', status_changed_at: '2026-02-01T00:00:00.000Z', status_reason: 'USER_STOP',
    });
  });

  it('refuses a transition the machine does not allow', async () => {
    const harness = createLifecycleHarness();
    const agentId = await seedDomain(harness, { status: 'DESTROYED' });
    await expect(writeStatus({ documents: harness.documents, agentId, to: 'ACTIVE' }))
      .rejects.toThrow(InvalidTransitionError);
  });

  it('reports a missing agent rather than creating one', async () => {
    const harness = createLifecycleHarness();
    await expect(writeStatus({ documents: harness.documents, agentId: 'agent-missing', to: 'REVOKED' }))
      .rejects.toThrow(AgentNotFound);
  });
});

describe('ownership', () => {
  it('returns 404 for an unknown agent and 403 for another subject', async () => {
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
