/**
 * The one place a link to an agent's own screen is built.
 *
 * T-APP-12 keeps every `agents/...` path inside this directory, next to the ownership
 * check, so that reaching an agent always goes through it. A screen that assembled its
 * own path would be the start of a second way in. The route this points at runs behind
 * `requireAgentOwner` like everything else about an agent.
 */
export function agentPagePath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}

/**
 * The two things a person can ask of an agent, as the paths they are asked at.
 *
 * They are here for the same reason the page path is: every route under
 * `/api/agents/:agent_id` runs behind `requireAgentOwner`, and a screen that assembled
 * its own path would be the start of a second way in. The screens import these; they
 * do not build them.
 */
export function agentInstructionsPath(agentId: string): string {
  return `/api${agentPagePath(agentId)}/instructions`;
}

export function agentStopPath(agentId: string): string {
  return `/api${agentPagePath(agentId)}/stop`;
}

/** The failure exercise, and the snapshot the agent screen polls while it runs. */
export function agentFaultsPath(agentId: string): string {
  return `/api${agentPagePath(agentId)}/faults`;
}

export function agentMonitorPath(agentId: string): string {
  return `/api${agentPagePath(agentId)}/monitor`;
}
