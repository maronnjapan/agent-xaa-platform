import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  ACTIVITY_EVENT_OUTCOMES, ACTIVITY_EVENT_PHASES, activityEventSchema, validateActivityEvent,
} from '../src/activity-event.js';

/**
 * docs 11 §3.1 as the schema sees it.
 *
 * The two enums are the whole point of validating an Activity Event: `phase` decides
 * which node a replay draws the step from, and `outcome` decides how strongly the row
 * is emphasised. A value outside either one would reach a renderer that has no branch
 * for it, so it is refused here rather than displayed as nothing.
 */
const example = {
  event_id: 'ev-1', trace_id: 'tr-1', human_subject: 'user-123', agent_id: null, task_id: 'provisioning',
  occurred_at: '2026-01-01T00:00:00.000Z', source: 'automation-app', phase: 'login', outcome: 'info',
  title: 'ログインしました', message: 'ログインしました。', related_finding_id: null, is_simulated: false,
} as const;

describe('the Activity Event schema', () => {
  it('rejects 8th phase', () => {
    expect(ACTIVITY_EVENT_PHASES).toHaveLength(7);
    expect([...ACTIVITY_EVENT_PHASES]).toEqual([
      'login', 'work_definition', 'authorization', 'provisioning', 'tool_call', 'security', 'lifecycle',
    ]);
    expect(() => validateActivityEvent({ ...example, phase: 'completed' })).toThrow();
  });

  it('rejects a fourth outcome', () => {
    expect(ACTIVITY_EVENT_OUTCOMES).toHaveLength(3);
    for (const outcome of ['denied', 'rejected', 'error']) {
      expect(() => validateActivityEvent({ ...example, outcome })).toThrow();
    }
  });

  it('accepts the example in docs 11 §3.1 unchanged', async () => {
    const path = new URL('./fixtures/activity-event-docs-example.json', import.meta.url).pathname;
    const documented = JSON.parse(await readFile(path, 'utf8')) as unknown;
    expect(() => validateActivityEvent(documented)).not.toThrow();
    // The offset form of the documented timestamp is accepted as written: rewriting it
    // to UTC in the fixture would test a different string than the document shows.
    expect((documented as { occurred_at: string }).occurred_at).toBe('2026-08-29T10:01:05+09:00');
  });

  it('accepts an omitted detail and refuses one unknown key', () => {
    expect(() => validateActivityEvent(example)).not.toThrow();
    expect(activityEventSchema.required).not.toContain('detail');
    expect(activityEventSchema.required).toHaveLength(13);
    expect(() => validateActivityEvent({ ...example, severity: 'INFO' })).toThrow();
  });
});
