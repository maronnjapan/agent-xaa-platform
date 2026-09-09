import { generateJson } from '@xaa/vertex';
import { suggestionListSchema } from '../schemas/index.js';
import type { WorkSignal } from '../signals/work-signal-source.js';

export interface Suggestion {
  candidate_id: string;
  title: string;
  description: string;
  context: string;
  done_criteria: string[];
  steps: string[];
  notes: string[];
}

export const SUGGESTION_FIELDS = [
  'candidate_id', 'title', 'description', 'context', 'done_criteria', 'steps', 'notes',
] as const;

export type Generate = <T>(params: {
  prompt: string; schema: object; maxOutputTokens: number; temperature: number;
}) => Promise<T | null>;

/**
 * Asks the model for ToDo candidates, and treats anything it cannot understand as no
 * candidate rather than as an error.
 *
 * A model that returns malformed JSON, or a candidate missing a field, is not an
 * outage — it is a suggestion engine having an off moment, and the person should see
 * an empty list, not a 500. Candidates are dropped one at a time so one bad entry does
 * not discard the good ones.
 *
 * The prompt names no capability, resource or isolation level. This app has no business
 * shaping what permissions get inferred (RULE-07), and a prompt that mentioned a
 * capability id would be doing exactly that.
 */
export async function suggestAutomations(input: {
  signals: readonly WorkSignal[];
  promptTemplate: string;
  generate?: Generate;
}): Promise<{ suggestions: Suggestion[] }> {
  const generate = input.generate ?? (<T>(params: Parameters<typeof generateJson>[0]) => generateJson<T>(params));
  const prompt = input.promptTemplate.replace('{{signals}}', JSON.stringify(input.signals));

  let answer: { suggestions?: unknown[] } | null;
  try {
    answer = await generate<{ suggestions?: unknown[] }>({
      prompt, schema: suggestionListSchema, maxOutputTokens: 4096, temperature: 0.2,
    });
  } catch {
    return { suggestions: [] };
  }
  if (!answer || !Array.isArray(answer.suggestions)) return { suggestions: [] };
  return { suggestions: answer.suggestions.filter(isSuggestion) };
}

function isSuggestion(value: unknown): value is Suggestion {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== SUGGESTION_FIELDS.length) return false;
  if (typeof record.candidate_id !== 'string' || record.candidate_id === '') return false;
  if (typeof record.title !== 'string' || record.title === '') return false;
  if (typeof record.description !== 'string' || typeof record.context !== 'string') return false;
  for (const key of ['done_criteria', 'steps', 'notes'] as const) {
    if (!Array.isArray(record[key]) || (record[key] as unknown[]).some((item) => typeof item !== 'string')) return false;
  }
  return true;
}
