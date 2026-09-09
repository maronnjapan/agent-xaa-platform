export interface PromptInput {
  description: string;
  operations: string[];
  /** Only the identifier and the human description; nothing technical. */
  taxonomy: Array<{ capability_id: string; description: string }>;
}

/** Anything that would tell the model where or how to call something. */
const TECHNICAL_MARKERS = ['https://', 'http://', 'endpoint', 'base_url', 'oauth', 'bearer', 'token_url'];

export class PromptContainsTechnicalValue extends Error {
  constructor(readonly marker: string) {
    super(`the prompt must not carry technical connection details: ${marker}`);
  }
}

/**
 * RULE-09. The model is told what the work is and which capabilities exist, and
 * nothing about how any of them is called. It cannot propose an endpoint it was
 * never shown, and it cannot leak one either.
 *
 * The check runs on every call, not only in development: a taxonomy row that quietly
 * gains a URL would otherwise start feeding it to the model.
 */
export function buildPrompt(input: PromptInput): string {
  const catalogue = input.taxonomy
    .map((entry) => `- ${entry.capability_id}: ${entry.description}`)
    .join('\n');
  const prompt = [
    'あなたは業務内容から必要な権限を推定する担当です。',
    '与えられた Capability の一覧から、この業務に必要なものだけを選んでください。',
    '一覧にない権限を作らないでください。',
    'note には、なぜその Capability が要ると考えたか、なぜ他を選ばなかったかを、日本語で簡潔に書いてください。',
    'note に URL や接続先の情報を書かないでください。',
    '',
    `業務内容: ${input.description}`,
    `想定される操作: ${input.operations.join(', ')}`,
    '',
    '選択できる Capability:',
    catalogue,
  ].join('\n');

  const lowered = prompt.toLowerCase();
  const found = TECHNICAL_MARKERS.find((marker) => lowered.includes(marker));
  if (found) throw new PromptContainsTechnicalValue(found);
  return prompt;
}
