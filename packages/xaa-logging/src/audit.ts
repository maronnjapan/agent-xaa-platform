import type { LogContext, Logger } from './types.js';

export interface AuditRecord {
  actor_type: 'human' | 'agent';
  actor_id: string;
  on_behalf_of: string;
  operation: string;
  resource: string;
  outcome: 'allowed' | 'denied' | 'error';
  occurred_at: string;
}

export class AuditSubjectError extends Error {}

export function writeAuditRecord(logger: Logger, ctx: LogContext, record: AuditRecord): void {
  if (record.actor_type === 'agent' && !record.on_behalf_of) throw new AuditSubjectError('agent audit subject is incomplete');
  if (record.actor_type === 'human' && record.on_behalf_of !== record.actor_id) throw new AuditSubjectError('human audit subject mismatch');
  if (record.actor_type === 'agent' && !record.actor_id.startsWith('urn:xaa:agent:')) throw new AuditSubjectError('invalid agent audit subject');
  if (ctx.agent_id !== null && record.actor_type === 'human') throw new AuditSubjectError('agent operation cannot be logged as human');
  logger.info('audit', ctx, { ...record });
}
