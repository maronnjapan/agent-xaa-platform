import { describe, expect, it } from 'vitest';
import {
  createAnthropicClient, createCliClient, createModelClient, createOpenAiClient,
  extractJson, ModelConfigurationError, readModelOptions,
} from '../src/index.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['value'],
  properties: { value: { type: 'string' } },
};
const params = { prompt: 'p', schema, maxOutputTokens: 64, temperature: 0 };

/**
 * DEC-APP-10 says the model is a deployment decision. `MODEL_PROVIDER` is how a
 * deployment names one that is not Gemini, and the rule these tests hold is that
 * choosing a different provider changes nothing a caller can observe: a schema-valid
 * answer or `null`, never a third thing.
 */
describe('choosing which model answers', () => {
  it('keeps VERTEX_MODE authoritative when MODEL_PROVIDER is unset', () => {
    expect(readModelOptions({ VERTEX_MODE: 'live', VERTEX_MODEL: 'gemini-x', PROJECT_ID: 'p' }).provider).toBe('vertex');
    expect(readModelOptions({ VERTEX_MODE: 'fake', VERTEX_MODEL: 'gemini-x' }).provider).toBe('fake');
    expect(readModelOptions({}).provider).toBe('fake');
  });

  /**
   * `VERTEX_MODEL` is a Gemini model name and every deployment sets it. Passing it on
   * to another provider would produce `claude --model gemini-2.5-flash` on a machine
   * that named neither.
   */
  it('does not hand the Vertex model name to a provider that is not Vertex', () => {
    const env = { VERTEX_MODEL: 'gemini-2.5-flash' };
    expect(readModelOptions({ ...env, MODEL_PROVIDER: 'vertex', PROJECT_ID: 'p' }).model).toBe('gemini-2.5-flash');
    expect(readModelOptions({ ...env, MODEL_PROVIDER: 'cli' }).model).toBe('');
    expect(readModelOptions({ ...env, MODEL_PROVIDER: 'cli', MODEL_NAME: 'opus' }).model).toBe('opus');
    expect(readModelOptions({ ...env, MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).model).toBe('');
  });

  it('reads the provider, the model and the credential from the deployment', () => {
    const options = readModelOptions({
      MODEL_PROVIDER: 'anthropic', MODEL_NAME: 'claude-x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gateway.test',
    });
    expect(options).toMatchObject({ provider: 'anthropic', model: 'claude-x', apiKey: 'k', baseUrl: 'https://gateway.test' });
  });

  it('refuses a provider it does not have, rather than falling back to one it does', () => {
    expect(() => readModelOptions({ MODEL_PROVIDER: 'gpt5' })).toThrow(ModelConfigurationError);
    expect(() => createModelClient({ provider: 'anthropic', model: 'claude-x' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createModelClient({ provider: 'openai', model: 'gpt-x' })).toThrow(/OPENAI_API_KEY/);
    expect(() => createModelClient({ provider: 'vertex', model: 'gemini-x' })).toThrow(/PROJECT_ID/);
    expect(() => createModelClient({ provider: 'cli', model: 'm', cliPreset: 'custom' })).toThrow(/MODEL_CLI_COMMAND/);
  });

  it('refuses MODEL_CLI_ARGS that is not a list of strings', () => {
    expect(() => readModelOptions({ MODEL_CLI_ARGS: 'exec -' })).toThrow(ModelConfigurationError);
    expect(() => readModelOptions({ MODEL_CLI_ARGS: '[1,2]' })).toThrow(ModelConfigurationError);
    expect(readModelOptions({ MODEL_CLI_ARGS: '["exec","-"]' }).cliArgs).toEqual(['exec', '-']);
  });
});

describe('Claude through the Messages API', () => {
  it('asks for the caller schema as a forced tool call, and returns what it fills in', async () => {
    let sent: Record<string, unknown> | undefined;
    const client = createAnthropicClient({
      model: 'claude-x', apiKey: 'k',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ content: [{ type: 'tool_use', input: { value: 'ok' } }] });
      }) as unknown as typeof fetch,
    });
    await expect(client.generateJson(params)).resolves.toEqual({ value: 'ok' });
    expect(sent).toMatchObject({
      model: 'claude-x',
      tools: [{ name: 'answer', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'answer' },
    });
  });

  it('answers null for a reply the schema does not accept, and for a refusal', async () => {
    const answering = (body: unknown, status = 200) => createAnthropicClient({
      model: 'claude-x', apiKey: 'k',
      fetchImpl: (async () => Response.json(body, { status })) as unknown as typeof fetch,
    });
    await expect(answering({ content: [{ type: 'tool_use', input: { other: 1 } }] }).generateJson(params)).resolves.toBeNull();
    await expect(answering({ error: 'overloaded' }, 529).generateJson(params)).resolves.toBeNull();
  });
});

describe('an OpenAI-compatible endpoint', () => {
  it('asks for the caller schema as the response format', async () => {
    let sent: { response_format?: { json_schema?: { schema?: unknown } } } | undefined;
    const client = createOpenAiClient({
      model: 'gpt-x', apiKey: 'k', baseUrl: 'https://gateway.test',
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe('https://gateway.test/v1/chat/completions');
        sent = JSON.parse(String(init.body)) as typeof sent;
        return Response.json({ choices: [{ message: { content: '{"value":"ok"}' } }] });
      }) as unknown as typeof fetch,
    });
    await expect(client.generateJson(params)).resolves.toEqual({ value: 'ok' });
    expect(sent?.response_format?.json_schema?.schema).toEqual(schema);
  });
});

describe('a coding agent on the machine', () => {
  it('sends the prompt on stdin and reads the answer out of whatever it printed', async () => {
    const seen: Array<{ command: string; args: readonly string[]; prompt: string }> = [];
    const client = createCliClient({
      preset: 'claude-code', model: 'claude-x',
      run: async (input) => {
        seen.push({ command: input.command, args: input.args, prompt: input.prompt });
        return 'Sure, here you go:\n\n```json\n{"value":"ok"}\n```\n';
      },
    });
    await expect(client.generateJson(params)).resolves.toEqual({ value: 'ok' });
    expect(seen[0]!.command).toBe('claude');
    expect(seen[0]!.args).toEqual(['-p', '--output-format', 'text', '--model', 'claude-x']);
    // The schema travels in the prompt, because this transport has no other channel
    // that could carry it.
    expect(seen[0]!.prompt).toContain(JSON.stringify(schema));
  });

  it('reads Codex from stdin too, and answers null when the command fails', async () => {
    expect(createCliClient({ preset: 'codex', run: async () => '' }));
    const failing = createCliClient({ preset: 'codex', run: async () => { throw new Error('not installed'); } });
    await expect(failing.generateJson(params)).resolves.toBeNull();
  });

  it('answers null for prose with no JSON in it', async () => {
    const client = createCliClient({ preset: 'claude-code', run: async () => 'I could not do that.' });
    await expect(client.generateJson(params)).resolves.toBeNull();
  });
});

describe('finding the answer inside a reply that is not only the answer', () => {
  it('takes the outermost balanced value and ignores braces inside strings', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('here: {"a":"}"} — done')).toEqual({ a: '}' });
    expect(extractJson('```json\n[1,2]\n```')).toEqual([1, 2]);
    expect(extractJson('nothing here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
