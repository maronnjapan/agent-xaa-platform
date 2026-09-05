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
