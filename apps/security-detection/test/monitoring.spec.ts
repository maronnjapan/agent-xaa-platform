import { describe, expect, it } from 'vitest';
import type { AnalysisRun } from '@xaa/contracts';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import { createAnalysisMonitor } from '../src/monitoring.js';
import { createSecurityDetection } from '../src/index.js';
import { AGENT_ID, baselineFor, createSecurityHarness, logEntry } from '../src/testing/harness.js';

const criticalLog = () => logEntry({ fields: { validation: 'human_subject_mismatch' } });
const read = async (documents: ReturnType<typeof createSecurityHarness>['documents']) =>
  (await documents.queryEqual<AnalysisRun>('security_analysis', [['human_subject', 'testuser']])).map((row) => row.data);
const aiResult = (response: string, confidence = 0.95) => JSON.stringify({
  deviation: { from_normal: 'unusual', capability_consistency: 'consistent' },
  judgement: { compromise_likelihood: 'low', false_positive_likelihood: 'high', causality: 'test' },
  impact: { scope: 'one agent', op_propagation: 'none' }, recommendation: { response, confidence },
});

describe('observable production analysis', () => {
  it('records stages and no AI invocation for ordinary logs, scoped to each subject', async () => {
    const h = createSecurityHarness();
    await h.runOnce([logEntry(), logEntry({ human_subject: 'another-person', trace_id: 'private-trace', fields: { secret: 'private-data' } })]);
    const [run] = await read(h.documents);
    expect(run).toMatchObject({ status: 'completed', input_count: 1, normalized_count: 1, decisions: [] });
    expect(run?.completed_stages).toEqual(['collect', 'normalize', 'validateProtocol', 'detectRules', 'correlate', 'score', 'analyze', 'respond']);
    expect(JSON.stringify(run)).not.toMatch(/another-person|private-data|private-trace/);
    expect(h.aiCalls).toBe(0);
  });

  it('explains missing baselines and AI fallback without claiming a quarantine occurred', async () => {
    const h = createSecurityHarness();
    await h.runOnce([criticalLog()]);
    expect((await read(h.documents))[0]?.decisions[0]).toMatchObject({ state: 'skipped', reason: 'baseline_missing', score: 100, score_breakdown: { critical_override: true } });
    await h.seedStore.set('agents', `${AGENT_ID}__baseline`, baselineFor() as unknown as Record<string, unknown>);
    await h.runOnce([criticalLog()]);
    const fallback = (await read(h.documents)).find((run) => run.decisions[0]?.reason === 'ai_fallback');
    expect(fallback?.decisions[0]).toMatchObject({ state: 'review', response: 'QUARANTINED', confidence: 0, transition: null });
    expect(h.transitions).toHaveLength(0);
  });

  it('publishes AI-in-progress before the model resolves, and records failures for retry', async () => {
    const firestore = createFirestoreDouble();
    const documents = createFirestoreDocumentStore(firestore, 'security-detection');
    await createFirestoreDocumentStore(firestore, 'provisioner').set('agents', `${AGENT_ID}__baseline`, baselineFor() as unknown as Record<string, unknown>);
    let reject!: (reason: Error) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const app = createSecurityDetection({ documents, sendToLifecycle: async () => new Response(null, { status: 202 }),
      analyze: () => { entered(); return new Promise<string>((_, fail) => { reject = fail; }); },
    });
    const running = app.runOnce([criticalLog()]);
    await ready;
    expect((await read(documents))[0]).toMatchObject({ status: 'running', stage: 'analyze', decisions: [{ state: 'analyzing', reason: 'score_requires_ai' }] });
    reject(new Error('secret-in-upstream-error'));
    await expect(running).rejects.toThrow('secret-in-upstream-error');
    const [failed] = await read(documents);
    expect(failed).toMatchObject({ status: 'failed', error_code: 'analysis_run_failed', decisions: [{ state: 'failed' }] });
    expect(JSON.stringify(failed)).not.toContain('secret-in-upstream-error');
  });

  it('records failed lifecycle requests and keeps disruptive recommendations for human review', async () => {
    const h = createSecurityHarness({ aiOutput: aiResult('SUSPICIOUS'), transitionStatus: 503 });
    await h.seedStore.set('agents', `${AGENT_ID}__baseline`, baselineFor() as unknown as Record<string, unknown>);
    await h.runOnce([criticalLog()]);
    expect((await read(h.documents))[0]?.decisions[0]).toMatchObject({ state: 'failed', reason: 'transition_failed', transition: 'failed' });
    const review = createSecurityHarness({ aiOutput: aiResult('QUARANTINED') });
    await review.seedStore.set('agents', `${AGENT_ID}__baseline`, baselineFor() as unknown as Record<string, unknown>);
    await review.runOnce([criticalLog()]);
    expect((await read(review.documents))[0]?.decisions[0]).toMatchObject({ state: 'review', reason: 'disruptive_response' });
    expect(review.transitions).toHaveLength(0);
  });
});


describe('analysis stage timing', () => {
  it('keeps the stage start stable through decision updates and closes a failed stage', async () => {
    const h = createSecurityHarness();
    let at = Date.parse('2026-09-09T00:00:00Z');
    const monitor = createAnalysisMonitor(h.documents, [logEntry()], () => at);
    await monitor.stage('collect');
    at += 125;
    await monitor.stage('normalize');
    at += 875;
    await monitor.stage('analyze');
    at += 2000;
    await monitor.decision('testuser', { finding_id: 'one', agent_id: AGENT_ID, codes: [], score: 50,
      level: 'MEDIUM', state: 'analyzing', reason: 'score_requires_ai', response: null, confidence: null, transition: null });
    expect((await read(h.documents))[0]).toMatchObject({ stage_started_at: '2026-09-09T00:00:01.000Z',
      stage_durations_ms: { collect: 125, normalize: 875 } });
    at += 3000;
    await monitor.finish(true);
    expect((await read(h.documents))[0]).toMatchObject({ status: 'failed',
      stage_durations_ms: { collect: 125, normalize: 875, analyze: 5000 } });
  });
});
