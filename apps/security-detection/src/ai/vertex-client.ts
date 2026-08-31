import { generateJson } from '@xaa/vertex';
import { securityAiOutputSchema } from './output.js';
import type { SecurityAiInput } from './input.js';

/**
 * The one place that talks to a model.
 *
 * Its parameter type is `SecurityAiInput` and nothing else — not `unknown`, not a
 * string. RULE-39 says a raw log never reaches the model; a signature that accepted a
 * string would make that a matter of discipline instead of a matter of types, and the
 * lint rule in this app's config keeps the normaliser out of this directory to close the
 * other half.
 *
 * The model name comes from the deployment (DEC-APP-10). There is no literal here.
 */
export async function analyze(input: SecurityAiInput): Promise<string | null> {
  const answer = await generateJson<Record<string, unknown>>({
    prompt: buildPrompt(input),
    schema: securityAiOutputSchema,
    maxOutputTokens: 2048,
    temperature: 0,
  });
  return answer === null ? null : JSON.stringify(answer);
}

function buildPrompt(input: SecurityAiInput): string {
  return [
    'あなたはエージェントの挙動を分析する役割です。以下の要約から4つの観点で判断してください。',
    '1. 通常からの逸脱と、Capability との整合',
    '2. 侵害の可能性、誤検知の可能性、原因の推定',
    '3. 影響範囲と、他の OP への波及',
    '4. 推奨する対応と、その確信度',
    '与えられた要約以外の情報を推測で補わないでください。',
    JSON.stringify(input),
  ].join('\n');
}
