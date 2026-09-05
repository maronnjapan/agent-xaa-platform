import { VertexAI } from '@google-cloud/vertexai';
import AjvModule from 'ajv';
import type { GenerateJsonParams, VertexClient } from './index.js';

const Ajv = (AjvModule as unknown as { default?: new (options?: object) => import('ajv').default }).default ?? AjvModule as unknown as new (options?: object) => import('ajv').default;

export interface LiveClientOptions {
  project: string;
  location: string;
  model: string;
  createSdk?: (project: string, location: string) => Pick<VertexAI, 'getGenerativeModel'>;
}

/**
 * The JSON Schema keywords Vertex refuses, dropped on the way out.
 *
 * `responseSchema` is an OpenAPI 3.0 subset, not JSON Schema: a key it does not know
 * is a 400, not an ignored field — `Unknown name "$id" at 'generation_config.
 * response_schema': Cannot find field`. The `$` keywords are identity and provenance,
 * never constraints, so removing them changes nothing about what the schema accepts;
 * the copy handed to Ajv below is still the schema as written.
 *
 * This is worth a function rather than an edit at the one call site that hit it. The
 * caller's schema is also the platform's contract for the answer, `$id` is how every
 * other schema in this repository is named, and a schema that fails here fails
 * silently: `generateContent` throws, the catch answers `null`, and the Authorization
 * Platform records "the model proposed nothing" for a request the model never saw.
 */
function forVertex(schema: object): object {
  if (Array.isArray(schema)) return schema.map((item) => (item && typeof item === 'object' ? forVertex(item as object) : item)) as unknown as object;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !key.startsWith('$'))
      .map(([key, value]) => [key, value && typeof value === 'object' ? forVertex(value as object) : value]),
  );
}

export function createLiveClient(options: LiveClientOptions): VertexClient {
  const sdk = options.createSdk?.(options.project, options.location) ?? new VertexAI({ project: options.project, location: options.location });
  const model = sdk.getGenerativeModel({ model: options.model });
  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      try {
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
          generationConfig: { maxOutputTokens: params.maxOutputTokens, temperature: params.temperature, responseMimeType: 'application/json', responseSchema: forVertex(params.schema) },
        });
        const text = result.response.candidates?.[0]?.content.parts?.map((part) => 'text' in part ? part.text : '').join('') ?? '';
        const value: unknown = JSON.parse(text);
        const validate = new Ajv({ strict: false }).compile(params.schema);
        return validate(value) ? value as T : null;
      } catch {
        return null;
      }
    },
  };
}
