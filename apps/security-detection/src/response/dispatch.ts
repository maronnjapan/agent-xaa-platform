import type { SecurityFinding } from '../correlate/finding.js';
import { canTransition, type AgentSecurityState } from './state.js';

export interface TransitionRequest {
  agent_id: string;
  from: AgentSecurityState;
  to: AgentSecurityState;
  finding_id: string;
  reason_code: string;
}

export type LifecycleSender = (request: TransitionRequest) => Promise<Response>;

/**
 * Asks the Lifecycle Manager to act. It never acts itself.
 *
 * Everything this service could do to an agent — stop issuance, cancel the job, destroy
 * the keys — is the Lifecycle Manager's, and going around it would mean two components
 * deciding when an agent's credentials stop working. The request carries the finding's
 * own type as its reason, never free text, so the far side records something a query can
 * group by.
 */
export async function requestTransition(input: {
  finding: SecurityFinding;
  from: AgentSecurityState;
  to: AgentSecurityState;
  send: LifecycleSender;
}): Promise<'sent' | 'refused'> {
  if (!input.finding.agent_id) return 'refused';
  if (!canTransition(input.from, input.to)) return 'refused';
  // Once. The far side is idempotent on the finding id, so a retry here would only
  // duplicate the record of the request.
  await input.send({
    agent_id: input.finding.agent_id,
    from: input.from,
    to: input.to,
    finding_id: input.finding.finding_id,
    reason_code: input.finding.finding_type,
  });
  return 'sent';
}
