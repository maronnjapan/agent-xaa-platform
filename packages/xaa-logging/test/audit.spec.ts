import { describe, expect, it, vi } from 'vitest';
import { AuditSubjectError, writeAuditRecord, type Logger } from '../src/index.js';

const logger = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), critical: vi.fn() } satisfies Logger;
const ctx = { request_id: 'r', trace_id: 't', agent_id: null, human_subject: 'user-1' };
const base = { actor_type: 'agent' as const, actor_id: 'urn:xaa:agent:agent-1', on_behalf_of: 'user-1', operation: 'read', resource: 'doc', outcome: 'allowed' as const, occurred_at: new Date(0).toISOString() };
describe('audit subject', () => {
  it('throws when agent record lacks on_behalf_of', () => expect(() => writeAuditRecord(logger, ctx, { ...base, on_behalf_of: '' })).toThrow(AuditSubjectError));
  it('throws when human record has different on_behalf_of', () => expect(() => writeAuditRecord(logger, ctx, { ...base, actor_type: 'human', actor_id: 'user-1', on_behalf_of: 'user-2' })).toThrow(AuditSubjectError));
  it('throws when agent_id present but actor_type is human', () => expect(() => writeAuditRecord(logger, { ...ctx, agent_id: 'agent-1' }, { ...base, actor_type: 'human', actor_id: 'user-1' })).toThrow(AuditSubjectError));
});
