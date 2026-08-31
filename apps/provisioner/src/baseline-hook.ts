import type { DocumentStore } from '@xaa/gcp';

export interface BaselineWrite {
  effective_capabilities: string[];
  expected_tools: string[];
  expected_resources: string[];
  expected_rate: { id_jag: { min: number; max: number }; api_request: { min: number; max: number } };
  lifetime: string;
  current_session_behavior: Record<string, number>;
}

/**
 * Writes the agent's baseline once, after provisioning has actually succeeded.
 *
 * Before this point the detector has nothing to compare against, which is why it emits
 * no rule hits for an agent it has no baseline for rather than guessing at one. Writing
 * it on a failed provisioning would leave a baseline for an agent that does not exist,
 * and the sweep would have one more orphan to reason about.
 *
 * There is no update path. Re-provisioning produces a new agent id and a new baseline
 * (RULE-29); rewriting an existing one would move the yardstick while it is being read.
 */
export async function writeAgentBaseline(input: {
  documents: DocumentStore;
  agentId: string;
  baseline: BaselineWrite;
}): Promise<void> {
  await input.documents.set('agents', `${input.agentId}__baseline`, input.baseline as unknown as Record<string, unknown>);
}
