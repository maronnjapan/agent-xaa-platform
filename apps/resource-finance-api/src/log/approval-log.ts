import type { LogContext, Logger } from '@xaa/logging';

export interface ApprovalAuditEntry {
  payment_id: string;
  amount: number;
  status: string;
  result: 'approved' | 'already_approved';
  /** The delegating human, from the Access Token `sub`. */
  approved_by: string;
  /** The agent that acted, from `act.sub`, in `urn:xaa:agent:` form. */
  approved_by_agent: string;
}

/**
 * RULE-46 / REQ-09-012. One approval writes one audit line naming both subjects, so
 * "on whose behalf" and "which agent" are answerable from the Resource side alone,
 * with no join.
 *
 * Both subjects are required strings: a token carrying only one of the two is refused
 * by the guard with 401, so no path reaches here with either missing.
 */
export function logApproval(logger: Logger, context: LogContext, entry: ApprovalAuditEntry): void {
  logger.info('resource_api.payment_approved', context, { ...entry });
}
