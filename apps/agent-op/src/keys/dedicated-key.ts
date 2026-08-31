import type { AgentOpConfig } from '../config.js';

/**
 * The signing key of a FULL_ISOLATION agent's dedicated OP.
 *
 * Blast radius (docs 05 §5): the dedicated key's public JWK goes into the same
 * shared JWK Set as the shared OP's, so a Resource AS cannot tell them apart and an
 * ID-JAG forged with either key is equally acceptable to it. What FULL_ISOLATION
 * narrows is the set of registrations and refresh tokens one process can reach, not
 * the breadth of what its key could sign. Do not describe it as narrowing forgery.
 */
export interface DedicatedKeyBinding {
  /** The fully qualified KMS key version, injected verbatim. Never assembled here. */
  keyVersionName: string;
  kidPrefix: string;
  /** null on the shared OP; the bound agent id on a dedicated one. */
  boundAgentId: string | null;
}

export function resolveKeyBinding(config: AgentOpConfig): DedicatedKeyBinding {
  return {
    keyVersionName: config.kmsIdjagKey,
    // 00b: shared is `op-shared-<version>`, dedicated is `idjag-<short>-<version>`.
    kidPrefix: config.agentId === null ? 'op-shared' : `idjag-${shortIdOf(config.agentId)}`,
    boundAgentId: config.agentId,
  };
}

/** DEC-IAC-07: `<short>` is the last twelve characters of the agent id's random part. */
export function shortIdOf(agentId: string): string {
  return agentId.slice(-12);
}

export class AgentBindingError extends Error {
  readonly code = 'invalid_grant';
  constructor() { super('The grant could not be issued for this agent'); }
}

/**
 * A dedicated OP serves exactly one agent. The shared OP applies no such check, so
 * the same code path works for both without a mode flag.
 */
export function assertAgentBinding(binding: DedicatedKeyBinding, requestedAgentId: string): void {
  if (binding.boundAgentId !== null && binding.boundAgentId !== requestedAgentId) throw new AgentBindingError();
}
