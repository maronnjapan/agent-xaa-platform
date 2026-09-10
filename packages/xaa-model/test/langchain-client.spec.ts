import { describe, expect, it } from 'vitest';
import { createLangChainClient, LANGCHAIN_PROVIDER_NAMES, type LangChainProvider } from '../src/index.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['value'],
  properties: { value: { type: 'string' } },
};
const params = { prompt: 'p', schema, maxOutputTokens: 64, temperature: 0 };

/** The request a provider actually put on the wire, and a canned reply for it. */
function answering(reply: unknown, status = 200): { sent: Array<Record<string, unknown>>; fetchImpl: typeof fetch } {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(reply, { status });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const REPLY = {
  // Anthropic answers a forced tool call; OpenAI answers a JSON Schema response format.
  anthropic: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tool_1', name: 'answer', input: { value: 'ok' } }] },
  openai: { id: 'c1', object: 'chat.completion', created: 0, model: 'gpt-x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"value":"ok"}' } }] },
} as const satisfies Record<LangChainProvider, unknown>;

/**
 * One client reaches every provider in the table, and the platform's contract is the
 * same whichever answers: the value the caller's schema describes, or `null`. These
 * exercise the provider packages themselves rather than a stand-in for them, because
 * what the consolidation replaced was precisely the code that built these requests.
 */
describe('a model reached through LangChain', () => {
  it.each(LANGCHAIN_PROVIDER_NAMES)('asks %s for the caller schema and returns what it filled in', async (provider) => {
    const { sent, fetchImpl } = answering(REPLY[provider]);
    const client = createLangChainClient({ provider, model: 'm', apiKey: 'k', fetchImpl });
    await expect(client.generateJson(params)).resolves.toEqual({ value: 'ok' });
    // Whatever channel the provider has for a schema, the caller's schema is what went
    // into it: Anthropic's forced tool input, OpenAI's json_schema response format.
    expect(JSON.stringify(sent[0])).toContain(JSON.stringify(schema.properties));
  });

  it.each(LANGCHAIN_PROVIDER_NAMES)('answers null when %s refuses the request', async (provider) => {
    const { fetchImpl } = answering({ error: { type: 'invalid_request_error', message: 'no' } }, 400);
    const client = createLangChainClient({ provider, model: 'm', apiKey: 'k', fetchImpl });
    await expect(client.generateJson(params)).resolves.toBeNull();
  });

  it('answers null for a reply the caller schema does not accept', async () => {
    const { fetchImpl } = answering({
      ...REPLY.openai,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"other":1}' } }],
    });
    const client = createLangChainClient({ provider: 'openai', model: 'gpt-x', apiKey: 'k', fetchImpl });
    await expect(client.generateJson(params)).resolves.toBeNull();
  });

  /**
   * Neither a tool input nor a JSON Schema response format may be a bare array, so a
   * schema like this has no channel to travel in and goes in the prompt instead.
   */
  it('carries a schema whose root is not an object in the prompt', async () => {
    const listSchema = { type: 'array', items: { type: 'string' } };
    const { sent, fetchImpl } = answering({
      ...REPLY.openai,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'here you go: ["a","b"]' } }],
    });
    const client = createLangChainClient({ provider: 'openai', model: 'gpt-x', apiKey: 'k', fetchImpl });
    await expect(client.generateJson({ ...params, schema: listSchema })).resolves.toEqual(['a', 'b']);
    expect(sent[0]).not.toHaveProperty('response_format');
    expect(JSON.stringify(sent[0])).toContain(JSON.stringify(listSchema).replaceAll('"', '\\"'));
  });

  it('sends the caller max tokens and temperature, and the base URL the deployment named', async () => {
    const { sent, fetchImpl } = answering(REPLY.openai);
    let seen: string | undefined;
    const client = createLangChainClient({
      provider: 'openai', model: 'gpt-x', apiKey: 'k', baseUrl: 'https://gateway.test/v1',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen = String(url);
        return fetchImpl(url as string, init);
      }) as unknown as typeof fetch,
    });
    await client.generateJson({ ...params, maxOutputTokens: 512, temperature: 0.4 });
    expect(seen).toBe('https://gateway.test/v1/chat/completions');
    expect(sent[0]).toMatchObject({ model: 'gpt-x', max_tokens: 512, temperature: 0.4 });
  });
});
