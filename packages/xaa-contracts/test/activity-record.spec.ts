import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_RECORD_CHECK_RESULTS, ACTIVITY_RECORD_OUTCOMES, RECORD_TEXT_LIMIT, RECORD_TRUNCATION_MARK,
  redactRecordText, validateActivityRecord,
} from '../src/activity-record.js';
import { ACTIVITY_EVENT_OUTCOMES, validateActivityEvent } from '../src/activity-event.js';
import { INITIAL_TASK_ID, TASK_ID_PATTERN, classifyTaskId } from '../src/task-boundary.js';

/**
 * docs 11 §3.4. The record is the answer to "what actually happened inside this step",
 * and its shape is what keeps that answer honest: every word in it is a `label`, a
 * `message` or a `text`, so a publisher has to write the sentence and a renderer has
 * nowhere to compose one.
 */
const record = {
  headline: 'internal.document.list を実行しました',
  step: 1,
  checks: [
    { id: 'allowed_tools', label: '許可されたツールに入っているか', result: 'passed', message: '2 件に含まれていました。' },
    { id: 'constraints', label: '人が付けた条件を満たすか', result: 'skipped', message: '条件は付いていません。' },
  ],
  sections: [
    {
      id: 'request',
      label: '送ったリクエスト',
      message: 'GET で呼びました。',
      fields: [{ label: 'メソッド', value: 'GET' }],
      text: '{"a":1}',
      format: 'json',
    },
  ],
  hops: [
    { from: 'agent-runtime', to: 'resource-api', label: 'GET /documents', outcome: 'info', message: '送りました。' },
  ],
} as const;

describe('the Activity Record schema', () => {
  it('says the same three things about an outcome as the event does', () => {
    expect([...ACTIVITY_RECORD_OUTCOMES]).toEqual([...ACTIVITY_EVENT_OUTCOMES]);
  });

  it('keeps skipped as a check result of its own', () => {
    // A call refused at step 2 never reached the constraint check. Reporting that as
    // `passed` would claim a limit was honoured that was never looked at.
    expect([...ACTIVITY_RECORD_CHECK_RESULTS]).toEqual(['passed', 'blocked', 'failed', 'skipped']);
  });

  it('accepts a full record and refuses an unknown key anywhere in it', () => {
    expect(() => validateActivityRecord(record)).not.toThrow();
    expect(() => validateActivityRecord({ ...record, severity: 'INFO' })).toThrow();
    expect(() => validateActivityRecord({ ...record, checks: [{ ...record.checks[0], extra: 1 }] })).toThrow();
    expect(() => validateActivityRecord({ ...record, sections: [{ ...record.sections[0], extra: 1 }] })).toThrow();
    expect(() => validateActivityRecord({ ...record, hops: [{ ...record.hops[0], extra: 1 }] })).toThrow();
  });

  it('refuses a check verdict and a hop outcome outside their lists', () => {
    expect(() => validateActivityRecord({
      ...record, checks: [{ ...record.checks[0], result: 'maybe' }],
    })).toThrow();
    expect(() => validateActivityRecord({
      ...record, hops: [{ ...record.hops[0], outcome: 'denied' }],
    })).toThrow();
  });

  /** A record with no headline is a panel with no answer in it. */
  it('requires a headline and a sections array', () => {
    expect(() => validateActivityRecord({ sections: [] })).toThrow();
    expect(() => validateActivityRecord({ headline: 'x' })).toThrow();
    expect(() => validateActivityRecord({ headline: 'x', sections: [] })).not.toThrow();
  });
});

describe('an event carrying a record', () => {
  const event = {
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: 'user-123', agent_id: null, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
    title: 'ツールを実行しました', message: '実行しました。', related_finding_id: null, is_simulated: false,
  } as const;

  it('is optional, and validated when it is there', () => {
    expect(() => validateActivityEvent(event)).not.toThrow();
    expect(() => validateActivityEvent({ ...event, record })).not.toThrow();
    // A publisher that got the shape wrong fails at the publisher, not on a screen.
    expect(() => validateActivityEvent({ ...event, record: { headline: '' } })).toThrow();
    expect(() => validateActivityEvent({ ...event, record: 'text' })).toThrow();
  });
});

describe('redaction on the way out', () => {
  it('removes a token that arrived inside a serialised body', () => {
    const body = '{"access_token":"eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.signature","title":"T"}';
    const cleaned = redactRecordText(body);
    expect(cleaned).not.toMatch(/eyJ/);
    expect(cleaned).toContain('[REDACTED]');
    expect(cleaned).toContain('"title":"T"');
  });

  /**
   * The reason the pattern is anchored on `eyJ` rather than on dots. Every tool id in
   * the platform is three dotted segments, so a looser test eats the one value the
   * whole record is about.
   */
  it('leaves a dotted identifier alone', () => {
    for (const value of ['internal.document.list', 'not_in_allowed_tools', 'docs.read']) {
      expect(redactRecordText(value)).toBe(value);
    }
  });

  it('truncates rather than carrying a dump onto a screen', () => {
    const long = redactRecordText('あ'.repeat(RECORD_TEXT_LIMIT + 500));
    expect(long.endsWith(RECORD_TRUNCATION_MARK)).toBe(true);
    expect(long.length).toBe(RECORD_TEXT_LIMIT + RECORD_TRUNCATION_MARK.length);
  });
});

/**
 * The id an agent's first Execution runs under has to be one the timeline can file.
 * A work definition id was passed here, and `readTimeline` dropped every event the
 * agent produced without saying so.
 */
describe('the initial task id', () => {
  it('is a task id the timeline can group by', () => {
    expect(TASK_ID_PATTERN.test(INITIAL_TASK_ID)).toBe(true);
    expect(classifyTaskId(INITIAL_TASK_ID)).toBe('task');
    expect(classifyTaskId('wd_9f0c1e2a-0000-4000-8000-000000000000')).toBeNull();
  });
});
