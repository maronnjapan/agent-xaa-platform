import { describe, expect, it } from 'vitest';
import { SIGNAL_KINDS, WORK_SIGNAL_FIELDS } from '../src/signals/work-signal-source.js';
import { createSignalSource, SIGNAL_SOURCES } from '../src/signals/registry.js';
import { loadSuggestionPrompt } from '../src/prompts/load.js';
import { startAutomationApp } from './helpers.js';

const DOCS = 'https://resource-docs-api.test';

function documentsResponse(types: readonly string[]): Response {
  return new Response(JSON.stringify({
    documents: types.map((type, index) => ({
      document_id: `doc-${index}`, type, title: `${type} の記録`, occurred_at: '2026-01-01T00:00:00.000Z',
    })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('the Document RS work signal source', () => {
  it('normalizes 6 types', async () => {
    const calls: string[] = [];
    const source = createSignalSource('document-rs', {
      baseUrl: DOCS,
      authorization: async () => 'Bearer app-identity',
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return String(url).includes('/documents/')
          ? new Response(JSON.stringify({ body: '本文' }), { status: 200 })
          : documentsResponse([...SIGNAL_KINDS, 'note']);
      }) as unknown as typeof fetch,
    });

    const signals = await source.fetch({
      humanSubject: 'testuser', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z',
    });
    expect(signals).toHaveLength(6);
    expect(signals.map((signal) => signal.source_kind)).toEqual([...SIGNAL_KINDS]);
    expect(signals.every((signal) => signal.human_subject === 'testuser')).toBe(true);
    expect(signals.every((signal) => signal.body === '本文')).toBe(true);
    // `note` is a document type with no signal kind, so it is dropped rather than
    // carried through under a name the rest of the app would have to know about.
    expect(signals.map((signal) => signal.title)).not.toContain('note の記録');
    expect(calls[0]).toContain('from=2026-01-01T00%3A00%3A00.000Z');
  });

  it('gives every record exactly the six fields', async () => {
    const source = createSignalSource('document-rs', {
      baseUrl: DOCS,
      authorization: async () => 'Bearer app-identity',
      withBody: false,
      fetchImpl: (async () => documentsResponse(['work_log'])) as unknown as typeof fetch,
    });
    const signals = await source.fetch({ humanSubject: 'testuser', from: 'a', to: 'b' });
    expect(new Set(Object.keys(signals[0]!))).toEqual(new Set(WORK_SIGNAL_FIELDS));
  });

  it("sends the app's own identity, not an agent's delegation", async () => {
    const headers: Array<Record<string, string>> = [];
    const source = createSignalSource('document-rs', {
      baseUrl: DOCS,
      authorization: async () => 'Bearer app-identity',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers.push(init.headers as Record<string, string>);
        return documentsResponse([]);
      }) as unknown as typeof fetch,
    });
    await source.fetch({ humanSubject: 'testuser', from: 'a', to: 'b' });
    expect(headers[0]).toEqual({ Authorization: 'Bearer app-identity' });
  });

  it('lists one source and resolves it by id', () => {
    expect(SIGNAL_SOURCES).toHaveLength(1);
    expect(SIGNAL_SOURCES[0]).toBe('document-rs');
    expect(typeof createSignalSource('document-rs', {
      baseUrl: DOCS, authorization: async () => '',
    }).fetch).toBe('function');
  });
});

describe('the suggestion route as it runs in production', () => {
  it('reads the period from the request and the instructions from the prompt file', async () => {
    const prompts: string[] = [];
    const harness = await startAutomationApp({
      generate: async (params) => { prompts.push(params.prompt); return { suggestions: [] }; },
      upstreamHandler: (url) => (url.includes('/documents/')
        ? new Response(JSON.stringify({ body: '毎朝おなじ集計をしている' }), { status: 200 })
        : documentsResponse(['work_log'])),
    });

    const response = await harness.fetch('/api/automation/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' }),
    });
    expect(response.status).toBe(200);

    const listed = harness.upstream.find((call) => call.url.startsWith(`${DOCS}/documents?`));
    expect(listed?.url).toContain('to=2026-01-02T00%3A00%3A00.000Z');
    // The file the reviewers read is the file the model is sent, not a placeholder.
    expect(prompts[0]).toContain(loadSuggestionPrompt().split('\n')[0]);
    expect(prompts[0]).toContain('毎朝おなじ集計をしている');
    expect(prompts[0]).not.toContain('{{signals}}');
  });

  it('refuses a request with no period rather than analysing everything', async () => {
    const harness = await startAutomationApp();
    const response = await harness.fetch('/api/automation/suggestions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });
});
