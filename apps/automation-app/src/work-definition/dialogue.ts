import { generateJson } from '@xaa/vertex';
import { workDefinitionDraftSchema, DRAFT_FIELDS } from '../schemas/index.js';
import type { Generate } from '../automation/suggestions.js';
import type { WorkDefinition } from './model.js';

export { DRAFT_FIELDS };

export type WorkDefinitionDraft = Pick<WorkDefinition, (typeof DRAFT_FIELDS)[number]>;

/**
 * One turn of the conversation that shapes a ToDo.
 *
 * The model rewrites six fields and cannot touch a seventh. `status` is absent from
 * the schema and from the returned shape, so no phrasing — "confirmed", "final", "I
 * have approved this" — can move the ToDo forward: that transition belongs to a click
 * on the confirm route and to nothing else (RULE-08). The priority and the due date are
 * absent too: they are the person's ordering of their own list, not wording.
 *
 * A model that fails or answers something unusable leaves the ToDo exactly as it was.
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
    title: input.definition.title,
    description: input.definition.description,
    context: input.definition.context,
    done_criteria: input.definition.done_criteria,
    steps: input.definition.steps,
    notes: input.definition.notes,
  };
  let answer: unknown;
  try {
    answer = await generate<unknown>({
      prompt: 'AI エージェントに実行してもらう ToDo の下書きを、利用者の依頼に合わせて書き直してください。\n'
        + '書き直すのはタイトル、説明、実行時のコンテキスト（背景と前提）、完了条件、手順、注意点の6項目だけです。\n'
        + '依頼に書かれていない項目は今の値をそのまま返してください。\n'
        + 'どの権限が必要かは書かないでください。判断は別の仕組みが行います。\n'
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
  if (typeof record.title !== 'string' || record.title.trim() === '') return false;
  if (typeof record.description !== 'string' || typeof record.context !== 'string') return false;
  for (const key of ['done_criteria', 'steps', 'notes'] as const) {
    if (!Array.isArray(record[key]) || (record[key] as unknown[]).some((item) => typeof item !== 'string' || item === '')) return false;
  }
  return true;
}
