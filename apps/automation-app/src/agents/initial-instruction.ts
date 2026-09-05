import type { DocumentStore } from '@xaa/gcp';
import { addInstruction, AgentNotActive } from './instructions.js';
import type { WorkDefinition } from '../work-definition/model.js';

/**
 * The work definition, in the words the person confirmed, as the new agent's first
 * instruction.
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
 * It is the confirmed text, never the draft: `submit` refuses a definition that is not
 * CONFIRMED, so what reaches here is what the person read before they approved the
 * permissions derived from it.
 */
export function buildInitialInstruction(definition: WorkDefinition): string {
  const section = (heading: string, lines: readonly string[]): string[] =>
    (lines.length === 0 ? [] : [heading, ...lines.map((line) => `- ${line}`)]);

  return [
    'これがあなたに委譲された作業です。使用できるツールの範囲で進めてください。',
    `目的: ${definition.purpose}`,
    `内容: ${definition.description}`,
    ...section('手順:', definition.operations),
    ...section('確認したいこと:', definition.user_confirmations),
    ...section('注意点:', definition.safety_notes),
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
export async function seedInitialInstruction(input: {
  documents: DocumentStore;
  agentId: string;
  definition: WorkDefinition;
  now?: number;
}): Promise<'written' | 'agent_not_active' | 'failed'> {
  try {
    await addInstruction({
      documents: input.documents,
      agentId: input.agentId,
      text: buildInitialInstruction(input.definition),
      createdBy: input.definition.human_subject,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return 'written';
  } catch (error) {
    return error instanceof AgentNotActive ? 'agent_not_active' : 'failed';
  }
}
