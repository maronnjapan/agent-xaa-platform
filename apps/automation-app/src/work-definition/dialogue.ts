import { generateJson } from '@xaa/vertex';
import { workDefinitionDraftSchema } from '../schemas/index.js';
import type { Generate } from '../automation/suggestions.js';
import type { WorkDefinition } from './model.js';

export const DRAFT_FIELDS = [
  'purpose', 'description', 'operations', 'user_confirmations', 'safety_notes',
] as const;

export type WorkDefinitionDraft = Pick<WorkDefinition, (typeof DRAFT_FIELDS)[number]>;

/**
 * One turn of the conversation that shapes a draft.
 *
 * The model rewrites five fields and cannot touch a sixth. `status` is absent from the
 * schema and from the returned shape, so no phrasing — "confirmed", "final", "I have
 * approved this" — can move the draft forward: that transition belongs to a click on
 * the confirm route and to nothing else (RULE-08).
 *
 * A model that fails or answers something unusable leaves the draft exactly as it was.
 * The person's own words are already saved; losing them because a generation call
 * timed out would be the worse failure.
 */
export async function reviseDraft(input: {
  definition: WorkDefinition;
  message: string;
  generate?: Generate;
}): Promise<WorkDefinitionDraft | null> {
  const generate = input.generate ?? (<T>(params: Parameters<typeof generateJson>[0]) => generateJson<T>(params));
  const current: WorkDefinitionDraft = {
    purpose: input.definition.purpose,
    description: input.definition.description,
    operations: input.definition.operations,
    user_confirmations: input.definition.user_confirmations,
    safety_notes: input.definition.safety_notes,
  };
  let answer: unknown;
  try {
    answer = await generate<unknown>({
      prompt: '自動化したい作業の下書きを、利用者の依頼に合わせて書き直してください。\n'
        + '書き直すのは目的、説明、手順、確認したいこと、注意点の5項目だけです。\n'
        + '依頼に書かれていない項目は今の値をそのまま返してください。\n'
        + `現在の下書き:\n${JSON.stringify(current)}\n利用者の依頼:\n${input.message}`,
      schema: workDefinitionDraftSchema,
      maxOutputTokens: 2048,
      temperature: 0.2,
    });
  } catch {
    return null;
  }
  return isDraft(answer) ? answer : null;
}

function isDraft(value: unknown): value is WorkDefinitionDraft {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== DRAFT_FIELDS.length) return false;
  if (typeof record.purpose !== 'string' || typeof record.description !== 'string') return false;
  for (const key of ['operations', 'user_confirmations', 'safety_notes'] as const) {
    if (!Array.isArray(record[key]) || (record[key] as unknown[]).some((item) => typeof item !== 'string')) return false;
  }
  return true;
}
