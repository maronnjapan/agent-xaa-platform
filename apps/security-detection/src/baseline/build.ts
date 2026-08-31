import type { AgentBaseline } from './types.js';

export const BASE_RATE = {
  id_jag: { min: 2, max: 20 },
  api_request: { min: 10, max: 100 },
} as const;

/**
 * What normal looks like for one agent, fixed when it is created.
 *
 * The rate ceiling scales with how many tools the agent has, because an agent with eight
 * tools legitimately makes more calls than one with two. The formula lives here alone —
 * a second copy would drift, and a drifted baseline is a detector that fires on ordinary
 * work or misses an attack.
 *
 * `lifetime` is copied from the registration rather than recomputed: the agent's expiry
 * was decided once, and a second calculation is a second answer.
 */
export function buildBaseline(input: {
  effectiveCapabilities: readonly string[];
  expectedTools: readonly string[];
  expectedResources: readonly string[];
  expiresAt: string;
}): AgentBaseline {
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
    // Zeroed at creation; the rule pass increments it as the agent works.
    current_session_behavior: {
      token_request: 0, id_jag_issued: 0, api_request: 0, auth_failure: 0,
    },
  };
}
