import { describe, expect, it } from 'vitest';
import * as expiry from '../src/agent/expiry.js';
import { computeExpiresAt, HARD_CAP_SECONDS, inheritExpiresAt } from '../src/agent/expiry.js';

/**
 * RULE-25 / REQ-07-001. An agent lives at most a day.
 *
 * The ceiling is enforced twice on purpose. Terraform validates the variable, so a
 * deployment cannot ask for more; the code clamps whatever it was actually handed,
 * because exporting an environment variable by hand is not a deployment. An operator
 * doing that must be able to shorten an agent's life and never to lengthen it.
 *
 * DEC-IAC-16 is what makes the shorter value useful: a verification profile sets an
 * hour, and every layer — the job timeout, the registration, the connection — follows
 * that one variable rather than each holding its own idea of "a day".
 */
const NOW = Date.parse('2026-03-01T00:00:00.000Z');

describe('how long an agent lives', () => {
  it('clamps at a day even when the environment allows two', () => {
    const result = computeExpiresAt({ requestedLifetimeMinutes: 48 * 60, agentMaxLifetimeSeconds: 172_800, now: NOW });
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(HARD_CAP_SECONDS * 1000);
    expect(result.lifetimeSeconds).toBe(HARD_CAP_SECONDS);
    expect(HARD_CAP_SECONDS).toBe(86_400);
  });

  it('honours a shorter ceiling than the request', () => {
    const result = computeExpiresAt({ requestedLifetimeMinutes: 60, agentMaxLifetimeSeconds: 3600, now: NOW });
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(3600 * 1000);
    expect(result.lifetimeSeconds).toBe(3600);
  });

  it('honours a request shorter than the ceiling', () => {
    const result = computeExpiresAt({ requestedLifetimeMinutes: 120, agentMaxLifetimeSeconds: 86_400, now: NOW });
    expect(result.lifetimeSeconds).toBe(7200);
  });

  /**
   * The reason the request is counted in minutes: a three-minute errand used to have
   * to ask for an hour, because an hour was both the unit and the floor.
   */
  it('gives an agent asked for in minutes exactly those minutes', () => {
    const result = computeExpiresAt({ requestedLifetimeMinutes: 3, agentMaxLifetimeSeconds: 86_400, now: NOW });
    expect(result.lifetimeSeconds).toBe(180);
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(180 * 1000);
  });

  it('floors a request below a minute at one minute rather than at zero', () => {
    // A job handed a timeout of zero is refused outright, which is a worse answer than
    // an agent that expires almost immediately.
    expect(computeExpiresAt({ requestedLifetimeMinutes: 0, agentMaxLifetimeSeconds: 86_400, now: NOW })
      .lifetimeSeconds).toBe(60);
  });

  it('returns RFC 3339 in UTC, to the second', () => {
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    const result = computeExpiresAt({
      // A `now` that is not on a second boundary: the truncation has to happen, not
      // merely be invisible in a fixture that was already round.
      requestedLifetimeMinutes: 8 * 60, agentMaxLifetimeSeconds: 86_400, now: NOW + 1234,
    });
    expect(result.createdAt).toMatch(rfc3339);
    expect(result.expiresAt).toMatch(rfc3339);
    expect(Date.parse(result.expiresAt) - Date.parse(result.createdAt)).toBe(8 * 3600 * 1000);
  });

  /**
   * There is no way to move an expiry once it is set. A permission change produces a
   * replacement agent that inherits the old expiry (T-PROV-16); recomputing it there
   * would let anyone keep an agent alive indefinitely by adjusting their own
   * permissions every few hours.
   */
  it('exports nothing that could rewrite an expiry', () => {
    expect(Object.keys(expiry).sort()).toEqual([
      'HARD_CAP_SECONDS', 'computeExpiresAt', 'inheritExpiresAt', 'toRfc3339Seconds',
    ]);
    for (const name of Object.keys(expiry)) expect(name).not.toMatch(/^(update|set|extend|refresh|renew)/i);
  });

  it('copies an inherited expiry instead of extending it', () => {
    const inherited = '2026-03-01T04:00:00Z';
    const result = inheritExpiresAt({ inheritedExpiresAt: inherited, now: NOW });
    expect(Date.parse(result!.expiresAt)).toBe(Date.parse(inherited));
    expect(result!.lifetimeSeconds).toBe(4 * 3600);
    // An expiry already past leaves nothing to inherit; the caller answers 400 rather
    // than minting an agent that is dead on arrival.
    expect(inheritExpiresAt({ inheritedExpiresAt: '2026-02-28T23:00:00Z', now: NOW })).toBeUndefined();
  });
});
