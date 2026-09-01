import { workDefinitionHash } from '@xaa/contracts';
import type { LogContext, Logger } from '@xaa/logging';

/** The seven fields of `authz_ai.infer` (docs 09 §2), and no eighth. */
export interface AiInferenceFields {
  agent_draft_id: string;
  work_definition_id: string;
  work_definition_hash: string;
  proposed_capabilities: string[];
  confidence: number;
  taxonomy_version: string;
  model_version: string;
}

/**
 * The hash stands in for the work definition's text. Detection needs to tell two
 * inferences over the same work apart from two over different work; it does not need
 * to read what the person wrote, and the log is the one place that text would
 * otherwise leak into (RULE-38).
 *
 * `purpose` is outside the hash on purpose: it is free text the person may reword
 * without changing what the agent would be allowed to do.
 */
export function inferenceInputHash(input: { description: string; operations: readonly string[] }): Promise<string> {
  return workDefinitionHash({ description: input.description, operations: [...input.operations] });
}

/** One line per inference. Prompt and response are never written. */
export function logAiInference(logger: Logger, context: LogContext, fields: AiInferenceFields): void {
  logger.info('authz_ai.infer', context, { ...fields });
}
