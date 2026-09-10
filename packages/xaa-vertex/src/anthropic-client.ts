import { extractJson, validateAnswer } from './json-answer.js';
import type { GenerateJsonParams, VertexClient } from './index.js';

export interface AnthropicClientOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

const ANTHROPIC_VERSION = '2023-06-01';
/** The name the forced tool call is given; it never reaches the caller. */
const ANSWER_TOOL = 'answer';

/**
 * Claude through the Messages API, answering with the caller's schema.
 *
 * The schema is passed as a tool's `input_schema` and the tool is forced, rather than
 * asked for in the prompt: a forced tool call is the one channel this API has that is
 * shaped by a schema, so the reply comes back as an object rather than as prose that
 * has to be parsed out of a paragraph. A schema whose root is not an object cannot be
 * a tool input, so those fall back to a prompt-carried schema and `extractJson`.
 */
export function createAnthropicClient(options: AnthropicClientOptions): VertexClient {
  const endpoint = new URL('/v1/messages', options.baseUrl ?? 'https://api.anthropic.com').toString();
  const call = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      const asTool = (params.schema as { type?: unknown }).type === 'object';
      const body = {
        model: options.model,
        max_tokens: params.maxOutputTokens,
        temperature: params.temperature,
        messages: [{
          role: 'user',
          content: asTool
            ? params.prompt
            : `${params.prompt}\n\nAnswer with one JSON value and nothing else, validating against this JSON Schema:\n${JSON.stringify(params.schema)}`,
        }],
        ...(asTool
          ? {
            tools: [{ name: ANSWER_TOOL, description: 'Return the answer as structured JSON.', input_schema: params.schema }],
            tool_choice: { type: 'tool', name: ANSWER_TOOL },
          }
          : {}),
      };
      try {
        const response = await call(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) return null;
        const payload = await response.json() as {
          content?: Array<{ type?: string; text?: string; input?: unknown }>;
        };
        const blocks = payload.content ?? [];
        const toolUse = blocks.find((block) => block.type === 'tool_use');
        const value = toolUse
          ? toolUse.input
          : extractJson(blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''));
        return validateAnswer<T>(value, params.schema);
      } catch {
        return null;
      }
    },
  };
}
