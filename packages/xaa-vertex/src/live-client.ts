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

export function createLiveClient(options: LiveClientOptions): VertexClient {
  const sdk = options.createSdk?.(options.project, options.location) ?? new VertexAI({ project: options.project, location: options.location });
  const model = sdk.getGenerativeModel({ model: options.model });
  return {
    async generateJson<T>(params: GenerateJsonParams): Promise<T | null> {
      try {
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
          generationConfig: { maxOutputTokens: params.maxOutputTokens, temperature: params.temperature, responseMimeType: 'application/json', responseSchema: params.schema },
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
