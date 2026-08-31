export const AUDIT_OPERATIONS = ['status_read', 'stop', 'add_instruction'] as const;
export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

export type AuditResult = 'success' | 'denied';

export interface AgentOperationAudit {
  operation: AuditOperation;
  agent_id: string;
  actor_type: 'human';
  actor_id: string;
  on_behalf_of: string;
  occurred_at: string;
  result: AuditResult;
  instruction_text?: string;
}

/**
 * The audit record for the three things a person can do to a running agent.
 *
 * The argument type has no field for a token, and that is the safeguard: a caller
 * cannot pass one, so no amount of later editing puts an Access Token or a DPoP proof
 * into an audit line (RULE-38). `instruction_text` is the one free-text field, and it
 * is here on purpose — an instruction is what the person actually asked for, and the
 * record is worth little without it.
 *
 * A refused operation is logged too. "Someone tried to read an agent that is not
 * theirs" is exactly the line that matters later, and the 404 the caller sees says
 * nothing about whether the agent exists.
 */
export function logAgentOperation(
  entry: AgentOperationAudit,
  write: (line: string) => void = (line) => process.stdout.write(line),
): void {
  write(`${JSON.stringify({
    severity: entry.result === 'denied' ? 'WARNING' : 'INFO',
    logType: 'xaa.audit',
    ...entry,
  })}\n`);
}
