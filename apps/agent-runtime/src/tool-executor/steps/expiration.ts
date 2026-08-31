import type { ToolFailed } from '../errors.js';

export class AgentExpired extends Error {
  readonly code = 'agent_expired';
}

/**
 * step3. Re-evaluated on every single tool call.
 *
 * Reasoning can run for a long time, so an agent that was valid when the loop started
 * may not be when its fourth tool call comes round. Caching the verdict — or computing
 * it once at startup — would let an expired agent keep acting.
 *
 * Both sides are compared as epoch milliseconds. `Date.parse` on an RFC 3339 UTC string
 * is timezone-independent; anything that formatted a local time first would make the
 * expiry depend on where the container happened to run.
 */
export function assertNotExpired(nowMs: number, expiresAt: string, toolId: string): ToolFailed | null {
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) throw new Error(`invalid expires_at: ${expiresAt}`);
  if (nowMs < expiry) return null;
  return {
    // Not `blocked`: nothing decided this agent may not act. Its time simply ran out,
    // and the terminal event classification (T-RUN-26) keeps the two apart.
    outcome: 'failed',
    reason: 'agent_expired',
    error_code: 'agent_expired',
    tool_id: toolId,
    stage: 'tool_selection',
  };
}
