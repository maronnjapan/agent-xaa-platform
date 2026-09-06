import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { validateActivityEvent, type ActivityEvent } from '@xaa/contracts';
import { AGENT_ID, SUBJECT, seedAgent, startAutomationApp, type Harness } from './helpers.js';
import { html } from './render.js';
import { FindingCard, FINDING_NOT_ANALYSED, FINDING_NO_ANALYSIS } from '../src/ui/components/finding-card.js';
import { SECURITY_CLEAR, SECURITY_EMPTY } from '../src/ui/pages/security.js';
import { readFindingsFor } from '../src/agents/findings.js';

const OTHER_SUBJECT = 'someone-else';
const OTHER_AGENT_ID = 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz';

/** A stored finding, exactly as Security Detection writes one. */
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finding_id: 'f_1_abcdef01',
    finding_type: 'potential_agent_compromise',
    agent_id: AGENT_ID,
    human_subject: SUBJECT,
    window_start: '2026-01-01T12:00:00.000Z',
    window_end: '2026-01-01T12:10:00.000Z',
    // Two things the browser must never be handed: the ids of the log lines the finding
    // was made from, and the deviation records, each of which carries a trace id.
    related_events: ['corr-1', 'corr-2'],
    deviations: [{
      kind: 'unexpected_tool', observed: 'x', expected: [],
      occurred_at: '2026-01-01T12:01:00.000Z', trace_id: 'trace-1',
    }],
    contributing_codes: ['isolation.dedicated_op_mismatch'],
    risk_score: 85,
    risk_level: 'CRITICAL',
    review_status: 'pending',
    created_at: '2026-01-01T12:10:00.000Z',
    recommended_response: 'QUARANTINED',
    confidence: 0.82,
    analysis_source: 'model',
    analyzed_at: '2026-01-01T12:10:05.000Z',
    analysis: {
      deviation: { from_normal: '他の OP へ届いています', capability_consistency: '権限の範囲を超えています' },
      judgement: { compromise_likelihood: '高い', false_positive_likelihood: '低い', causality: '同一 trace です' },
      impact: { scope: 'この Agent のみ', op_propagation: '共有 OP への波及なし' },
      recommendation: { response: 'QUARANTINED', confidence: 0.82 },
    },
    ...overrides,
  };
}

/** The detector's own view of Firestore: this app may read these rows and never write one. */
async function seedFinding(harness: Harness, finding: Record<string, unknown>): Promise<void> {
  await harness.detectorSeed.set('security_findings', String(finding.finding_id), finding);
}

async function seedEvent(harness: Harness, overrides: Partial<ActivityEvent> = {}): Promise<void> {
  const event = validateActivityEvent({
    event_id: 'ev-1', trace_id: 'tr-1', human_subject: SUBJECT, agent_id: AGENT_ID, task_id: 'task-1',
    occurred_at: '2026-01-01T00:00:00.000Z', source: 'agent-runtime', phase: 'tool_call', outcome: 'success',
    title: '作業が終わりました', message: '作業が終わりました。',
    detail: { event_type: 'TASK_COMPLETED', purpose: '日報をまとめる' },
    related_finding_id: null, is_simulated: false,
    ...overrides,
  }) as ActivityEvent;
  await harness.documents.set('user_activity', event.event_id, { ...event, expire_at: '2026-01-08T00:00:00.000Z' });
}

/** A person with one agent on their timeline. */
async function withAgent(): Promise<Harness> {
  const harness = await startAutomationApp();
  await seedAgent(harness);
  await seedEvent(harness);
  return harness;
}

/**
 * The screen that answers "what does the thing watching my agent make of it".
 *
 * Security Detection decides; this app reads its rows and prints them. So the assertions
 * are about two things and no third: that the read is narrowed to the session's own
 * subject, and that what it holds reaches the page unaltered — minus the evidence a
 * browser must never be handed.
 */
describe('the analysis page', () => {
  it('is served as HTML with its stylesheet and its script', async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored());
    const response = await harness.fetch('/security');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('data-page="security"');
    expect(body).toContain('src="/app.js"');
    expect(body).toContain('href="/styles/app.css"');
  });

  it("prints the analyser's own words and its verdict", async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored());
    const body = await (await harness.fetch('/security')).text();
    expect(body).toContain('他の OP へ届いています');
    expect(body).toContain('権限の範囲を超えています');
    expect(body).toContain('同一 trace です');
    expect(body).toContain('共有 OP への波及なし');
    expect(body).toContain('data-risk-level="CRITICAL"');
    expect(body).toContain('isolation.dedicated_op_mismatch');
  });

  it('hands the browser the judgement and none of the evidence behind it', async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored());
    const body = await (await harness.fetch('/security')).text();
    expect(body).not.toContain('trace-1');
    expect(body).not.toContain('corr-1');
    expect(body).not.toContain('related_events');
  });

  it("shows nobody else's finding, whoever the agent belongs to", async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored({ finding_id: 'f_mine' }));
    await seedFinding(harness, stored({
      finding_id: 'f_theirs', human_subject: OTHER_SUBJECT, agent_id: OTHER_AGENT_ID,
      analysis: { ...(stored().analysis as Record<string, unknown>), impact: { scope: '別の人の Agent', op_propagation: '—' } },
    }));
    const body = await (await harness.fetch('/security')).text();
    expect(body).toContain('data-finding-id="f_mine"');
    expect(body).not.toContain('data-finding-id="f_theirs"');
    expect(body).not.toContain('別の人の Agent');
  });

  it('keeps a section for an agent with nothing against it, and says so', async () => {
    const harness = await withAgent();
    const body = await (await harness.fetch('/security')).text();
    expect(body).toContain(`data-agent-id="${AGENT_ID}"`);
    expect(body).toContain(SECURITY_CLEAR);
  });

  it('shows a finding against an agent the timeline never mentioned', async () => {
    // The one case where a person most wants to be told: something was judged about an
    // agent that produced no timeline row of its own.
    const harness = await startAutomationApp();
    await seedFinding(harness, stored({ finding_id: 'f_orphan', agent_id: OTHER_AGENT_ID }));
    const body = await (await harness.fetch('/security')).text();
    expect(body).toContain(`data-agent-id="${OTHER_AGENT_ID}"`);
    expect(body).toContain('data-finding-id="f_orphan"');
  });

  it('says there is nothing to show when the person has no agent and no finding', async () => {
    const harness = await startAutomationApp();
    expect(await (await harness.fetch('/security')).text()).toContain(SECURITY_EMPTY);
  });

  it('sends an unauthenticated visitor to the login screen', async () => {
    const harness = await withAgent();
    const response = await harness.fetch('/security', { headers: { cookie: '' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });
});

describe('reading the findings', () => {
  it('answers newest first', async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored({ finding_id: 'f_early', created_at: '2026-01-01T12:00:00.000Z' }));
    await seedFinding(harness, stored({ finding_id: 'f_late', created_at: '2026-01-01T13:00:00.000Z' }));
    const findings = await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT });
    expect(findings.map((finding) => finding.finding_id)).toEqual(['f_late', 'f_early']);
  });

  it('answers null for the parts the analysis stage has not written', async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored({
      review_status: 'none',
      recommended_response: undefined, confidence: undefined,
      analysis: undefined, analysis_source: undefined, analyzed_at: undefined,
    }));
    const [finding] = await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT });
    expect(finding).toMatchObject({
      recommended_response: null, confidence: null, analysis: null,
      analysis_source: null, analyzed_at: null,
    });
  });

  it('drops a row it cannot read rather than failing the whole screen', async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored());
    // Three ways a document can be unreadable: no id at all, a finding type outside the
    // closed vocabulary, and a risk level the screen has no name for.
    await harness.detectorSeed.set('security_findings', 'f_no_id', {
      human_subject: SUBJECT, finding_id: '', agent_id: AGENT_ID,
    });
    await seedFinding(harness, stored({ finding_id: 'f_odd_type', finding_type: 'something_else' }));
    await seedFinding(harness, stored({ finding_id: 'f_odd_level', risk_level: 'CATASTROPHIC' }));
    const findings = await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT });
    expect(findings.map((finding) => finding.finding_id)).toEqual(['f_1_abcdef01']);
  });

  it('still renders the rest of the page when one row is unreadable', async () => {
    const harness = await withAgent();
    await seedFinding(harness, stored());
    await seedFinding(harness, stored({ finding_id: 'f_odd_type', finding_type: 'something_else' }));
    const response = await harness.fetch('/security');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('data-finding-id="f_1_abcdef01"');
    expect(body).not.toContain('data-finding-id="f_odd_type"');
  });

  it('may not write to the collection it reads', async () => {
    const harness = await withAgent();
    await expect(harness.documents.set('security_findings', 'f_x', {}))
      .rejects.toThrow(/Firestore access denied: automation-app write/);
  });
});

describe('one finding, rendered', () => {
  const view = async (harness: Harness) => {
    const [finding] = await readFindingsFor({ documents: harness.documents, humanSubject: SUBJECT });
    return finding!;
  };

  it('tells a missing analysis apart from one the model could not produce', async () => {
    const missing = await startAutomationApp();
    await seedFinding(missing, stored({
      analysis: undefined, analysis_source: undefined, analyzed_at: undefined,
      recommended_response: undefined, confidence: undefined, review_status: 'none',
    }));
    expect(html(createElement(FindingCard, { finding: await view(missing) }))).toContain(FINDING_NOT_ANALYSED);

    // The model answered with something unusable and the risk level decided alone. A
    // screen showing this the same way as a real judgement would present a default as a
    // conclusion.
    const fallback = await startAutomationApp();
    await seedFinding(fallback, stored({ analysis: undefined, analysis_source: 'fallback' }));
    const rendered = html(createElement(FindingCard, { finding: await view(fallback) }));
    expect(rendered).toContain(FINDING_NO_ANALYSIS);
    expect(rendered).toContain('リスク値だけで決めた既定の対応');
  });

  it("names the closed vocabularies in the reader's language and prints the rest as it came", async () => {
    const harness = await startAutomationApp();
    await seedFinding(harness, stored());
    const rendered = html(createElement(FindingCard, { finding: await view(harness) }));
    expect(rendered).toContain('侵害の可能性');
    expect(rendered).toContain('隔離');
    expect(rendered).toContain('確認待ち');
    expect(rendered).toContain('82%');
    expect(rendered).toContain('スコア 85');
    // The instant is served as recorded; the browser re-sets it to the reader's zone.
    expect(rendered).toContain('2026-01-01T12:10:00.000Z');
  });
});
