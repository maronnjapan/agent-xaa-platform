import { describe, expect, it } from 'vitest';
import { TASK_ID_PATTERN, TERMINAL_EVENTS, classifyTaskId, isTerminalEvent } from '../src/task-boundary.js';

/**
 * docs 11 §3.3. A task is replayed only once its terminal event has arrived, so both
 * halves of that sentence — which ids name a task, and which events end one — have to
 * come from this one table. Anything that recognised a task id by prefix would let
 * `task-0` and `provisioning-1` through and then group two people's work together.
 */
describe('task ids', () => {
  it('rejects task-abc', () => {
    expect(classifyTaskId('task-abc')).toBeNull();
    expect(TASK_ID_PATTERN.test('task-abc')).toBe(false);
  });

  it('rejects task-0, task-01 and provisioning-1', () => {
    for (const invalid of ['task-0', 'task-01', 'provisioning-1']) {
      expect(classifyTaskId(invalid)).toBeNull();
    }
    expect(classifyTaskId('task-1')).toBe('task');
    expect(classifyTaskId('task-10')).toBe('task');
    expect(classifyTaskId('provisioning')).toBe('provisioning');
    expect(classifyTaskId('lifecycle')).toBe('lifecycle');
    expect(classifyTaskId('demo-dpop-replay')).toBe('demo');
  });

  it('flattens to the eight terminal events of docs 11 §3.3', () => {
    const flattened = Object.values(TERMINAL_EVENTS).flat();
    expect(new Set(flattened)).toEqual(new Set([
      'AGENT_PROVISIONED',
      'TASK_COMPLETED', 'TASK_BLOCKED', 'TASK_FAILED',
      'AGENT_EXPIRED', 'AGENT_STOPPED', 'AGENT_QUARANTINED', 'AGENT_REVOKED_SECURITY',
    ]));
    expect(flattened).toHaveLength(8);
    expect(Object.keys(TERMINAL_EVENTS)).toHaveLength(3);
    // Each kind ends only on its own events: a provisioning task is not finished by
    // TASK_COMPLETED, however plausible the name looks.
    expect(isTerminalEvent('provisioning', 'AGENT_PROVISIONED')).toBe(true);
    expect(isTerminalEvent('provisioning', 'TASK_COMPLETED')).toBe(false);
    expect(isTerminalEvent('task-abc', 'TASK_COMPLETED')).toBe(false);
  });
});
