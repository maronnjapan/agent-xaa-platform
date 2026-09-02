import { describe, expect, it } from 'vitest';
import { AGENT_SECURITY_STATES, canTransition } from '../src/response/state.js';

/**
 * T-SEC-34 / docs 09 §6. The response ladder only climbs.
 *
 * A detector that could move an agent back to ACTIVE would be able to undo a
 * quarantine it had just asked for, and the record of why the agent was quarantined
 * would then disagree with its state. Reinstatement is a decision a person makes
 * through the Lifecycle Manager, not a step in this ladder.
 */
describe('the response state machine', () => {
  it('forward transitions only', () => {
    expect(AGENT_SECURITY_STATES).toHaveLength(5);
    const table = AGENT_SECURITY_STATES.flatMap((from, fromIndex) =>
      AGENT_SECURITY_STATES.map((to, toIndex) => ({
        from, to, allowed: canTransition(from, to), expected: toIndex > fromIndex,
      })));

    expect(table).toHaveLength(25);
    for (const pair of table) {
      expect(pair.allowed, `${pair.from} -> ${pair.to}`).toBe(pair.expected);
    }
    // Ten of the twenty-five climb; the other fifteen, staying put included, do not.
    expect(table.filter((pair) => pair.allowed)).toHaveLength(10);
  });

  it('refuses to stay put and refuses to go back', () => {
    expect(canTransition('ACTIVE', 'ACTIVE')).toBe(false);
    expect(canTransition('QUARANTINED', 'ACTIVE')).toBe(false);
    expect(canTransition('DESTROYED', 'REVOKED')).toBe(false);
    expect(canTransition('ACTIVE', 'DESTROYED')).toBe(true);
  });

  it('names an unknown state as no transition rather than throwing', () => {
    expect(canTransition('ACTIVE', 'RETIRED' as never)).toBe(false);
    expect(canTransition('RETIRED' as never, 'REVOKED')).toBe(false);
  });
});
