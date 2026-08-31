import { buildPrompt, type PromptInput } from './prompt.js';
import { sanitizeAiOutput, type AuthorizationAiResult, type Warning } from './output-guard.js';

export const authorizationAiResultSchema = {
  $id: 'authorization-ai-result',
  type: 'object',
  additionalProperties: false,
  required: ['capabilities', 'characteristics', 'confidence'],
  properties: {
    capabilities: { type: 'array', items: { type: 'string' } },
    characteristics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        write_operation: { type: 'boolean' },
        external_communication: { type: 'boolean' },
        financial_operation: { type: 'boolean' },
        sensitive_resource: { type: 'boolean' },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export interface VertexClient {
  generateJson<T>(params: { prompt: string; schema: object; maxOutputTokens: number; temperature: number }): Promise<T | null>;
}

/**
 * REQ-03-005. One call, structured output, and no retry loop: a model that answers
 * off-schema is treated as having proposed nothing rather than being asked again
 * until it complies.
 */
export async function inferCapabilities(
  input: PromptInput,
  deps: { vertex: VertexClient; onWarning?: (warning: Warning) => void },
): Promise<AuthorizationAiResult> {
  const prompt = buildPrompt(input);
  const raw = await deps.vertex.generateJson<unknown>({
    prompt, schema: authorizationAiResultSchema, maxOutputTokens: 1024, temperature: 0,
  });
  const { result, warnings } = sanitizeAiOutput(raw);
  for (const warning of warnings) deps.onWarning?.(warning);
  return result;
}
