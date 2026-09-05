import type { AgentBaseline } from '../baseline/types.js';
import type { NormalizedEvent } from '../normalize/index.js';
import type { ProtocolViolationRecord } from '../pipeline/types.js';

/**
 * The part of an Agent Registration a rule compares an observation against.
 *
 * Only the four fields that decide a verdict are read, and they are read as they are
 * stored in `agents/{agent_id}/meta` (00b §3). Copying the whole registration in here
 * would invite a rule to reason about a field nobody decided it should see.
 */
export interface AgentRegistrationView {
  idp_connection_id?: string | null;
  allowed_audiences?: readonly string[];
  resources?: readonly string[];
  /** The static XAA config the Provisioner injected: audiences, resources, scopes. */
  scopes?: readonly string[];
}

/**
 * Everything the six classifications are allowed to look at.
 *
 * A rule takes this and returns hits; it never reads Firestore, an environment variable
 * or the clock itself. That is what keeps a classification reproducible: the same batch
 * and the same registrations always produce the same hits, whenever the run happens.
 */
export interface RuleContext {
  events: readonly NormalizedEvent[];
  violations: readonly ProtocolViolationRecord[];
  baselines: ReadonlyMap<string, AgentBaseline>;
  registrations: ReadonlyMap<string, AgentRegistrationView>;
  /** From `AGENT_MAX_LIFETIME_SECONDS`; `null` when the deployment did not set it. */
  maxLifetimeSeconds: number | null;
}
