import { describe, expect, it } from 'vitest';
import { SECURITY_INSPECTION_CHECKS, assertSecurityInspectionView } from '@xaa/contracts';
import {
  INSPECTION_CHECKS, INSPECTIONS_COLLECTION, mergeInspection, type StoredInspection,
} from '../src/findings/inspection.js';
import { mergeFinding, type StoredFinding } from '../src/findings/stored.js';
import { AGENT_ID, baselineFor, createSecurityHarness, logEntry } from '../src/testing/harness.js';

const TOOL = 'internal.document.list';

async function seed(harness: ReturnType<typeof createSecurityHarness>, options: { baseline?: boolean } = {}): Promise<void> {
  if (options.baseline !== false) {
    await harness.seedStore.set('agents', `${AGENT_ID}__baseline`, baselineFor({
      expectedTools: [TOOL], expectedResources: ['https://resource-docs-api.test'],
    }) as never);
  }
  await harness.seedStore.set('agents', `${AGENT_ID}__meta`, {
    agent_id: AGENT_ID, human_subject: 'testuser', status: 'ACTIVE',
    isolation_level: 'standard', expires_at: '2026-01-02T00:00:00.000Z',
  });
}

/** One ordinary call, using a tool the baseline expects against a resource it expects. */
const ordinary = (trace: string) => logEntry({
  log_source: 'resource_api', app: 'resource-docs-api', event: 'api_request', trace_id: trace,
  fields: { resource: 'https://resource-docs-api.test', status: '200', tool_id: TOOL },
});

/** One refused request. Alone it scores 10 — the whole point of these tests. */
const refused = (trace: string) => logEntry({
  trace_id: trace, severity: 'WARNING', fields: { validation: 'expired_token', result: 'error' },
});

const findings = async (harness: ReturnType<typeof createSecurityHarness>): Promise<StoredFinding[]> =>
  (await harness.documents.listAll<StoredFinding>('security_findings')).map((row) => row.data);

const inspections = async (harness: ReturnType<typeof createSecurityHarness>): Promise<StoredInspection[]> =>
  (await harness.documents.listAll<StoredInspection>(INSPECTIONS_COLLECTION)).map((row) => row.data);

/**
 * What survives a run that found nothing worth a quarantine.
 *
 * Both halves of this used to be dropped. A window that tripped a rule but scored under
 * 30 was counted and thrown away, and a window that tripped nothing was never written at
 * all — so the console showed an empty page either way, and an empty page reads as 「ログ
 * が届いていない」 whatever the truth was. These tests are the two truths, kept apart.
 */
describe('a run that raised no finding worth the model', () => {
  it('keeps the LOW row rather than counting it away', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness);
    await harness.runOnce([refused('t1')]);

    const [finding] = await findings(harness);
    expect(finding).toMatchObject({
      risk_level: 'LOW', risk_score: 10, contributing_codes: ['expired_token'],
    });
    // The model is not asked and the Lifecycle Manager is not asked; only the row exists.
    expect(harness.aiCalls).toBe(0);
    expect(harness.transitions).toEqual([]);
  });

  it('says the mechanical passes are the whole of the answer, not that one is coming', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness);
    await harness.runOnce([refused('t1')]);

    const [finding] = await findings(harness);
    // Not undefined: the screen reads that as 「まだ分析されていません」, which promises an
    // analysis that will never arrive for a row below the threshold.
    expect(finding!.analysis_source).toBe('rules');
    expect(finding!.analysis).toBeUndefined();
    expect(finding!.review_status).toBe('none');
  });

  it('records that the logs were read even when nothing tripped at all', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness);
    await harness.runOnce([ordinary('t1')]);

    expect(await findings(harness)).toEqual([]);
    const [inspection] = await inspections(harness);
    expect(inspection).toMatchObject({
      agent_id: AGENT_ID, human_subject: 'testuser', events_examined: 1, codes_raised: [],
      checks_run: [...INSPECTION_CHECKS], checks_skipped: [],
    });
  });

  it('names the passes that could not run rather than reporting them clean', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness, { baseline: false });
    await harness.runOnce([ordinary('t1')]);

    const [inspection] = await inspections(harness);
    // Both compare the agent against a baseline the detector could not read, so both are
    // silent — and silent is not clean.
    expect(inspection!.checks_skipped).toEqual(['token_rate', 'baseline_deviation']);
    expect(inspection!.checks_run).not.toContain('token_rate');
    expect(inspection!.checks_run).not.toContain('baseline_deviation');
  });

  it('counts the whole window, not the last line of it', async () => {
    // The pull loop delivers one line at a time, so this is how a window really arrives.
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness);
    for (const trace of ['t1', 't2', 't3']) await harness.runOnce([ordinary(trace)]);

    const rows = await inspections(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.events_examined).toBe(3);
  });

  it('carries the raised codes so the record reads on its own', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness);
    await harness.runOnce([refused('t1')]);

    const [inspection] = await inspections(harness);
    expect(inspection!.codes_raised).toEqual(['expired_token']);
  });

  it('is a shape the console can narrow', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness);
    await harness.runOnce([ordinary('t1')]);

    const [inspection] = await inspections(harness);
    expect(() => assertSecurityInspectionView(inspection)).not.toThrow();
  });
});

describe('the inspection vocabulary', () => {
  it('matches the one the console is given', () => {
    expect([...INSPECTION_CHECKS]).toEqual([...SECURITY_INSPECTION_CHECKS]);
  });
});

/**
 * The same window, written twice.
 *
 * A finding id is derived from the window and the agent, and the pull loop delivers a
 * line at a time — so every window of any length is written more than once, and a plain
 * overwrite loses whatever the earlier writes established.
 */
describe('a second write of the same window', () => {
  const base: StoredFinding = {
    finding_id: 'f_1_abcdef01', finding_type: 'anomalous_agent_activity', agent_id: AGENT_ID,
    human_subject: 'testuser', window_start: '2026-01-01T12:00:00.000Z',
    window_end: '2026-01-01T12:10:00.000Z', related_events: ['c1'], contributing_codes: ['a'],
    risk_score: 40, risk_level: 'MEDIUM', review_status: 'pending', created_at: '2026-01-01T12:01:00.000Z',
  };

  const analysed: StoredFinding = {
    ...base,
    recommended_response: 'SUSPICIOUS', confidence: 0.8, analysis_source: 'model',
    analyzed_at: '2026-01-01T12:02:00.000Z',
    analysis: {
      deviation: { from_normal: 'x', capability_consistency: 'y' },
      judgement: { compromise_likelihood: 'a', false_positive_likelihood: 'b', causality: 'c' },
      impact: { scope: 'd', op_propagation: 'e' },
      recommendation: { response: 'SUSPICIOUS', confidence: 0.8 },
    },
  };

  const laterLow: StoredFinding = {
    ...base, related_events: ['c2'], contributing_codes: ['b'], risk_score: 10, risk_level: 'LOW',
    review_status: 'none', created_at: '2026-01-01T12:05:00.000Z',
    analysis_source: 'rules', analyzed_at: '2026-01-01T12:05:00.000Z',
  };

  it('does not let a LOW batch erase what the model already said', () => {
    const merged = mergeFinding(analysed, laterLow);
    expect(merged.analysis_source).toBe('model');
    expect(merged.analysis).toEqual(analysed.analysis);
    expect(merged.recommended_response).toBe('SUSPICIOUS');
    expect(merged.confidence).toBe(0.8);
    expect(merged.risk_level).toBe('MEDIUM');
    expect(merged.risk_score).toBe(40);
  });

  it('unions the evidence and keeps the first sighting as the detection time', () => {
    const merged = mergeFinding(analysed, laterLow);
    expect(merged.contributing_codes).toEqual(['a', 'b']);
    expect(merged.related_events).toEqual(['c1', 'c2']);
    expect(merged.created_at).toBe('2026-01-01T12:01:00.000Z');
  });

  it('keeps a decision a person took', () => {
    const reviewed: StoredFinding = { ...analysed, review_status: 'approved', reviewer: 'someone' };
    const merged = mergeFinding(reviewed, laterLow);
    expect(merged.review_status).toBe('approved');
    expect(merged.reviewer).toBe('someone');
  });

  it('lets the model stage write over a row the rules wrote first', () => {
    const merged = mergeFinding(laterLow, analysed);
    expect(merged.analysis_source).toBe('model');
    expect(merged.analysis).toEqual(analysed.analysis);
  });

  it('adds the inspection counts instead of replacing them', () => {
    const first: StoredInspection = {
      inspection_id: 'i_1_a', agent_id: AGENT_ID, human_subject: 'testuser',
      window_start: '2026-01-01T12:00:00.000Z', window_end: '2026-01-01T12:10:00.000Z',
      events_examined: 2, checks_run: ['protocol_validation'], checks_skipped: ['token_rate', 'baseline_deviation'],
      codes_raised: ['b'], last_seen_at: '2026-01-01T12:01:00.000Z',
    };
    const second: StoredInspection = {
      ...first, events_examined: 3, checks_run: ['protocol_validation', 'token_rate'],
      checks_skipped: ['baseline_deviation'], codes_raised: ['a'], last_seen_at: '2026-01-01T12:06:00.000Z',
    };
    const merged = mergeInspection(first, second);
    expect(merged.events_examined).toBe(5);
    expect(merged.codes_raised).toEqual(['a', 'b']);
    // The baseline arrived between the two batches, so the agent was measured after all.
    expect(merged.checks_run).toEqual(['protocol_validation', 'token_rate']);
    expect(merged.checks_skipped).toEqual(['baseline_deviation']);
    expect(merged.last_seen_at).toBe('2026-01-01T12:06:00.000Z');
  });
});

/**
 * A finding the model stage could not reach.
 *
 * MEDIUM and above are handed to the model, and the hand-off gives up silently when the
 * agent has no baseline to describe it with, or when the deployment configured no model.
 * The row was then left with no source at all, which the screen reads as 「まだ」.
 */
describe('a finding the model stage could not run on', () => {
  it('says the passes are all there is rather than leaving the row waiting', async () => {
    const harness = createSecurityHarness({ aiOutput: null });
    await seed(harness, { baseline: false });
    // An isolation breach scores 35 on its own, so it is MEDIUM with a single event.
    await harness.runOnce([logEntry({
      severity: 'WARNING', fields: { validation: 'human_subject_mismatch' },
    })]);

    const [finding] = await findings(harness);
    expect(finding!.risk_level).toBe('CRITICAL');
    expect(finding!.analysis_source).toBe('rules');
    // Nothing reasoned about it and nothing acted on it, so it waits for a person rather
    // than showing as 「不要（自動で対応済み）」.
    expect(finding!.review_status).toBe('pending');
    expect(harness.aiCalls).toBe(0);
    expect(harness.transitions).toEqual([]);
    expect(harness.logs.join('\n')).toContain('security_analysis_skipped');
  });
});
