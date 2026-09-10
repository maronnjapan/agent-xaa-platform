import { extractJson, validateAnswer } from './json-answer.js';
import type { GenerateJsonParams, VertexClient } from './index.js';

export interface OpenAiClientOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * An OpenAI-compatible Chat Completions endpoint, answering with the caller's schema.
 *
 * Chat Completions rather than Responses because it is the surface every
 * OpenAI-compatible server implements, which is what makes `OPENAI_BASE_URL` worth
 * having: the same client reaches OpenAI, a local server, or a gateway in front of
 * either. `strict` is left off, because the schemas in this repository use keywords
 * (`minimum`, `format`) that strict mode refuses, and the answer is validated here
 * anyway.
 */
export function createOpenAiClient(options: OpenAiClientOptions): VertexClient {
  const endpoint = new URL('/v1/chat/completions', options.baseUrl ?? 'https://api.openai.com').toString();
  const call = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      // `json_schema` requires an object root; anything else asks for `json_object`
      // and carries the schema in the prompt.
      const rootIsObject = (params.schema as { type?: unknown }).type === 'object';
      try {
        const response = await call(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({
            model: options.model,
            temperature: params.temperature,
            max_completion_tokens: params.maxOutputTokens,
            messages: [{
              role: 'user',
              content: rootIsObject
                ? params.prompt
                : `${params.prompt}\n\nAnswer with one JSON value and nothing else, validating against this JSON Schema:\n${JSON.stringify(params.schema)}`,
            }],
            response_format: rootIsObject
              ? { type: 'json_schema', json_schema: { name: 'answer', schema: params.schema } }
              : { type: 'json_object' },
          }),
        });
        if (!response.ok) return null;
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
        const text = payload.choices?.[0]?.message?.content ?? '';
        return validateAnswer<T>(extractJson(text), params.schema);
      } catch {
        return null;
      }
    },
  };
}
