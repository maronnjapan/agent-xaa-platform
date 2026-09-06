import { describe, expect, it } from 'vitest';
import {
  SECURITY_ANALYSIS_SOURCES, SECURITY_FINDING_TYPES, SECURITY_RESPONSE_STATES,
  SECURITY_REVIEW_STATUSES, SECURITY_RISK_LEVELS,
} from '@xaa/contracts';
import { FINDING_TYPES } from '../src/correlate/finding.js';
import { RESPONSE_STATES } from '../src/ai/output.js';
import { ANALYSIS_SOURCES, type StoredFinding } from '../src/findings/stored.js';
import { AGENT_ID, baselineFor, createSecurityHarness, logEntry } from '../src/testing/harness.js';

/**
 * The vocabularies exist twice — once here, where the detector writes them, and once in
 * `@xaa/contracts`, where the app that displays a finding narrows the stored document
 * into what a browser may have. A package cannot import back from an app, so the copies
 * are pinned here: a name added on this side and not the other would reach a screen as a
 * blank field.
 */
describe('the shared finding vocabularies', () => {
  it('match the ones the detector actually writes', () => {
    expect([...SECURITY_FINDING_TYPES]).toEqual([...FINDING_TYPES]);
    expect([...SECURITY_RESPONSE_STATES]).toEqual([...RESPONSE_STATES]);
    expect([...SECURITY_ANALYSIS_SOURCES]).toEqual([...ANALYSIS_SOURCES]);
    expect([...SECURITY_RISK_LEVELS]).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    expect([...SECURITY_REVIEW_STATUSES]).toEqual(['none', 'pending', 'approved', 'rejected']);
  });
});

/**
 * The analysis stage, from a delivered batch to what is left on the finding.
 *
 * Asserted through `runOnce` rather than against the update call, because the gap this
 * closes was never in either half on its own: the model's four aspects were produced and
 * then dropped, and the row that survived said `QUARANTINED` with nothing behind it.
 */
describe('what the analysis stage leaves behind', () => {
  const answer = JSON.stringify({
    deviation: { from_normal: '通常より多く要求しています', capability_consistency: 'Capability の範囲内です' },
    judgement: { compromise_likelihood: '中程度', false_positive_likelihood: '低い', causality: '同一 trace です' },
    impact: { scope: 'このAgentのみ', op_propagation: 'Shared OP への波及なし' },
    recommendation: { response: 'SUSPICIOUS', confidence: 0.82 },
  });

  const batch = () => [{
    jsonPayload: logEntry({ severity: 'WARNING', fields: { validation: 'human_subject_mismatch' } }),
  }];

  async function analysed(aiOutput: string | null): Promise<StoredFinding[]> {
    const harness = createSecurityHarness({ aiOutput, now: () => Date.parse('2026-01-01T12:30:00.000Z') });
    await harness.seedStore.set('agents', `${AGENT_ID}__baseline`, baselineFor() as never);
    await harness.runOnce(batch());
    const rows = await harness.documents.listAll<StoredFinding>('security_findings');
    return rows.map((row) => row.data);
  }

  it('keeps the model\'s reasoning, not only its verdict', async () => {
    const [finding] = await analysed(answer);
    expect(finding).toMatchObject({
      recommended_response: 'SUSPICIOUS', confidence: 0.82,
      analysis_source: 'model', analyzed_at: '2026-01-01T12:30:00.000Z',
    });
    expect(finding!.analysis).toEqual({
      deviation: { from_normal: '通常より多く要求しています', capability_consistency: 'Capability の範囲内です' },
      judgement: { compromise_likelihood: '中程度', false_positive_likelihood: '低い', causality: '同一 trace です' },
      impact: { scope: 'このAgentのみ', op_propagation: 'Shared OP への波及なし' },
      recommendation: { response: 'SUSPICIOUS', confidence: 0.82 },
    });
  });

  it('says so when the risk level decided alone', async () => {
    const [finding] = await analysed(null);
    expect(finding!.analysis).toBeUndefined();
    expect(finding!.analysis_source).toBe('fallback');
    // A fallback is always held for a person, so the screen shows a pending decision
    // rather than a recommendation something reasoned its way to.
    expect(finding!.review_status).toBe('pending');
  });
});
