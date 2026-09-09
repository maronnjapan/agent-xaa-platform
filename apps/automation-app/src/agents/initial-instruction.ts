import type { DocumentStore } from '@xaa/gcp';
import { addInstruction, AgentNotActive, type StoredInstruction } from './instructions.js';
import type { TodoPriority, WorkDefinition } from '../work-definition/model.js';

export const PRIORITY_WORDS: Readonly<Record<TodoPriority, string>> = { high: '高', normal: '中', low: '低' };

/**
 * The ToDo, in the words the person confirmed, as the new agent's first instruction.
 *
 * Nothing else carries it. The Runtime starts from ten environment values (00b §2) and
 * a Tool Manifest, none of which says what the agent is *for*: `TASK_ID` is an id, and
 * the manifest is the set of tools the decision allowed, not the job. So the first
 * reasoning step used to see a tool list and an empty history, and an agent asked to do
 * nothing in particular did nothing in particular.
 *
 * `agent_instructions` is the channel that already exists for this — the Automation App
 * writes it, the Runtime reads it at the head of every step (REQ-02-025) — and using it
 * rather than a new one keeps the guarantee that comes with it: an instruction is words
 * and nothing else, so this cannot widen what the agent may do. A first instruction
 * naming a tool the manifest lacks is refused by step2 exactly like a later one.
 *
 * The context the person wrote travels here whole: it is the background an agent
 * working unattended cannot ask for, and the done criteria are how it knows to stop.
 * It is the confirmed text, never the draft: `submit` refuses a ToDo that is not
 * CONFIRMED, so what reaches here is what the person read before they approved the
 * permissions derived from it.
 */
export function buildInitialInstruction(definition: WorkDefinition): string {
  const list = (heading: string, lines: readonly string[]): string[] =>
    (lines.length === 0 ? [] : [heading, ...lines.map((line) => `- ${line}`)]);
  const block = (heading: string, body: string): string[] => (body === '' ? [] : [heading, body]);

  return [
    'これがあなたに任された ToDo です。使用できるツールの範囲で進め、完了条件を満たしたら作業を終えてください。',
    `タイトル: ${definition.title}`,
    ...block('内容:', definition.description),
    ...block('背景と前提（実行時のコンテキスト）:', definition.context),
    ...list('完了条件:', definition.done_criteria),
    ...list('手順:', definition.steps),
    ...list('注意点:', definition.notes),
    `優先度: ${PRIORITY_WORDS[definition.priority]}`,
    ...(definition.due_on === null ? [] : [`期限: ${definition.due_on}`]),
  ].join('\n');
}

/**
 * Written after provisioning answered, because `addInstruction` requires the agent to
 * be ACTIVE and the flow reaches that status in its last step.
 *
 * A failure here is not a failure of provisioning: the agent exists, it is running, and
 * the person can still tell it what to do from its own screen. Reporting a 500 for the
 * request that created it would say the opposite. The caller is handed the error to
 * record instead.
 */
export type InitialInstructionOutcome =
  | { outcome: 'written'; instruction: StoredInstruction }
  | { outcome: 'agent_not_active' | 'failed' };

export async function seedInitialInstruction(input: {
  documents: DocumentStore;
  agentId: string;
  definition: WorkDefinition;
  now?: number;
}): Promise<InitialInstructionOutcome> {
  try {
    const instruction = await addInstruction({
      documents: input.documents,
      agentId: input.agentId,
      text: buildInitialInstruction(input.definition),
      createdBy: input.definition.human_subject,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return { outcome: 'written', instruction };
  } catch (error) {
    return { outcome: error instanceof AgentNotActive ? 'agent_not_active' : 'failed' };
  }
}
