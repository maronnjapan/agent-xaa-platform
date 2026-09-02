import { describe, expect, it } from 'vitest';
import { documentInternalWriteSchema, compile } from '@xaa/contracts';
import { buildDailyReport } from '../src/reports/daily-report.js';
import { startAutomationApp, SUBJECT } from './helpers.js';

const DOCS = 'https://resource-docs-api.test';

// This is the write the Automation App's own service identity makes (T-APP-05),
// not the XAA-protected `docs.write` create — the receiving schema is the internal
// writer's, which is what the request body actually has to satisfy.
const assertCreate: (value: unknown) => asserts value is unknown = compile(documentInternalWriteSchema);

function listing(types: readonly string[]): Response {
  return new Response(JSON.stringify({
    documents: types.map((type, index) => ({
      document_id: `doc-${index}`, type, title: `${type}`, occurred_at: '2026-01-01T09:00:00.000Z',
    })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function upstream(types: readonly string[]) {
  return (url: string): Response => {
    if (url.includes('/documents/')) return new Response(JSON.stringify({ body: '午前は集計、午後は確認' }), { status: 200 });
    if (url.startsWith(`${DOCS}/documents?`)) return listing(types);
    return new Response(JSON.stringify({ document_id: 'doc-new' }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('the daily report', () => {
  it('is built from work logs only', async () => {
    const report = await buildDailyReport({
      signals: [{
        source_kind: 'mail', occurred_at: '2026-01-01T09:00:00.000Z', human_subject: 'testuser',
        title: 'x', body: 'y', metadata: {},
      }],
      generate: async () => ({ title: '日報', body: '本文' }),
    });
    expect(report).toBeNull();
  });

  it('writes a document the Resource Server would accept', async () => {
    const harness = await startAutomationApp({
      generate: async () => ({ title: '1月1日の日報', body: '午前は集計、午後は確認' }),
      upstreamHandler: upstream(['work_log']),
      identityTokenProvider: async (audience) => `id-token-for-${audience}`,
    });

    const response = await harness.fetch('/api/reports/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:59.000Z' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ document_id: 'doc-new' });

    const write = harness.upstream.find((call) => call.init.method === 'POST');
    expect(write?.url).toBe(`${DOCS}/documents`);
    // The receiving schema is the one this body has to satisfy, so the test uses it
    // rather than a copy of the field names.
    const created = JSON.parse(String(write?.init.body)) as { type: string; title: string; occurred_at: string; human_subject: string };
    expect(() => assertCreate(created)).not.toThrow();
    // One document, of the one type a report is filed under: the timeline and the work
    // signal source both find it again by `type=daily_report` and nothing else.
    expect(created.type).toBe('daily_report');
    expect(created.title).toBe('1月1日の日報');
    expect(created.occurred_at).toBe('2026-01-01T23:59:59.000Z');
    // There is no Access Token `sub` on this call for the Resource Server to take an
    // owner from, so the request names the person itself (T-APP-05).
    expect(created.human_subject).toBe(SUBJECT);
    expect(harness.upstream.filter((call) => call.init.method === 'POST')).toHaveLength(1);
    expect((write?.init.headers as Record<string, string>).Authorization)
      .toBe(`Bearer id-token-for-${DOCS}`);
  });

  it('answers 422 when the period holds no work log', async () => {
    const harness = await startAutomationApp({
      generate: async () => ({ title: '日報', body: '本文' }),
      upstreamHandler: upstream(['mail', 'calendar']),
    });
    const response = await harness.fetch('/api/reports/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:59.000Z' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'no_work_log' });
    expect(harness.upstream.some((call) => call.init.method === 'POST')).toBe(false);
  });

  it('reads the period the request named', async () => {
    const harness = await startAutomationApp({
      generate: async () => ({ title: '日報', body: '本文' }),
      upstreamHandler: upstream(['work_log']),
    });
    await harness.fetch('/api/reports/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T23:59:59.000Z' }),
    });
    const listed = harness.upstream.find((call) => call.url.startsWith(`${DOCS}/documents?`));
    expect(listed?.url).toContain('from=2026-01-01T00%3A00%3A00.000Z');
    expect(listed?.url).toContain('to=2026-01-01T23%3A59%3A59.000Z');
  });
});
