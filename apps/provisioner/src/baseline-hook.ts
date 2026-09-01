import type { DocumentStore } from '@xaa/gcp';

/** The rate an ordinary agent works at, before the tool count scales the ceiling. */
const BASE_RATE = {
  id_jag: { min: 2, max: 20 },
  api_request: { min: 10, max: 100 },
} as const;

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

/**
 * The baseline for one agent, derived from what it was just given.
 *
 * The lifetime is short enough that no history accumulates, so the yardstick comes from
 * the definition rather than from observation (RULE-40). The ceiling scales with the
 * tool count because an agent with eight tools legitimately makes more calls than one
 * with two; the formula matches the detector's own, which is the only reason a hit
 * means anything.
 */
export function buildAgentBaseline(input: {
  effectiveCapabilities: readonly string[];
  expectedTools: readonly string[];
  expectedResources: readonly string[];
  expiresAt: string;
}): BaselineWrite {
  const factor = Math.max(1, Math.ceil(input.expectedTools.length / 2));
  return {
    effective_capabilities: [...input.effectiveCapabilities],
    expected_tools: [...input.expectedTools],
    expected_resources: [...new Set(input.expectedResources)],
    expected_rate: {
      id_jag: { min: BASE_RATE.id_jag.min, max: BASE_RATE.id_jag.max * factor },
      api_request: { min: BASE_RATE.api_request.min, max: BASE_RATE.api_request.max * factor },
    },
    lifetime: input.expiresAt,
    current_session_behavior: { token_request: 0, id_jag_issued: 0, api_request: 0, auth_failure: 0 },
  };
}
