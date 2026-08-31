import { compile } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import type { Logger, LogContext } from '@xaa/logging';
import { writeStatus } from '../status-writer.js';
import { InvalidTransitionError, type AgentStatus } from '../state-machine.js';
import type { CleanupOutcome } from '../cleanup/result.js';

export const identityDisabledSchema = {
  $id: 'human-identity-disabled',
  type: 'object',
  additionalProperties: false,
  required: ['human_subject', 'disabled_at'],
  properties: {
    human_subject: { type: 'string', minLength: 1 },
    disabled_at: { type: 'string', format: 'date-time' },
  },
} as const;

export interface IdentityDisabledEvent { human_subject: string; disabled_at: string }

const assertEvent: (value: unknown) => asserts value is IdentityDisabledEvent =
  compile<IdentityDisabledEvent>(identityDisabledSchema);

/** Six statuses can still be revoked; the terminal three are already settled. */
export const REVOCABLE_STATUSES: readonly AgentStatus[] = [
  'CREATED', 'PROVISIONING', 'ACTIVE', 'EXPIRING', 'SUSPICIOUS', 'QUARANTINED',
];

/**
 * A person's identity was disabled, so every agent acting for them stops now.
 *
 * RULE-28: the agent's authority is the person's authority. When that goes, remaining
 * lifetime is irrelevant — there is no branch here that looks at `expires_at` and no
 * delay before acting.
 *
 * Each agent is handled in its own try/catch and the loop continues. One agent whose
 * OP is unreachable must not leave the others running, and the message is acked either
 * way: redelivering it would re-run cleanup for agents already handled, and the failed
 * ones are picked up by the sweep instead.
 */
export async function handleIdentityDisabled(input: {
  message: unknown;
  documents: DocumentStore;
  logger: Logger;
  logContext: LogContext;
  cleanup(agentId: string, reason: 'IDENTITY_DISABLED'): Promise<CleanupOutcome>;
  now?: () => number;
}): Promise<{ revoked: string[]; failed: string[]; abandoned: number }> {
  const now = input.now ?? (() => Date.now());
  try {
    assertEvent(input.message);
  } catch {
    // Acked, not retried: a message that fails the schema will fail it forever.
    input.logger.warning('invalid_identity_disabled_event', input.logContext, {});
    return { revoked: [], failed: [], abandoned: 0 };
  }
  const event = input.message;

  // Transactions first, so a provisioning run in flight cannot produce an agent after
  // the enumeration below has already passed it.
  let abandoned = 0;
  const transactions = await input.documents.queryEqual<{ status: string }>('provisioning_transactions', [
    ['human_subject', event.human_subject],
  ]).catch(() => []);
  for (const row of transactions) {
    if (['COMPLETED', 'FAILED', 'ABANDONED'].includes(row.data.status)) continue;
    await input.documents.update('provisioning_transactions', row.id, { status: 'ABANDONED' }).catch(() => undefined);
    abandoned += 1;
  }

  const rows = await input.documents.queryRange<{ agent_id: string; human_subject: string; status: AgentStatus }>(
    'agents', 'agent_id', 'agent-', 'agent-￿',
  );
  const revoked: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    const meta = row.data;
    if (meta.human_subject !== event.human_subject) continue;
    if (!REVOCABLE_STATUSES.includes(meta.status)) continue;
    try {
      // EXPIRING cannot go straight to REVOKED, so it passes through EXPIRED first.
      if (meta.status === 'EXPIRING') {
        await writeStatus({ documents: input.documents, agentId: meta.agent_id, to: 'EXPIRED', now: now() });
      }
      await writeStatus({
        documents: input.documents, agentId: meta.agent_id, to: 'REVOKED',
        reason: 'IDENTITY_DISABLED', now: now(),
      }).catch((error) => { if (!(error instanceof InvalidTransitionError)) throw error; });
      await input.cleanup(meta.agent_id, 'IDENTITY_DISABLED');
      revoked.push(meta.agent_id);
    } catch {
      failed.push(meta.agent_id);
    }
  }
  if (failed.length > 0) input.logger.error('identity_disabled_partial', input.logContext, { failed_agents: failed });
  return { revoked, failed, abandoned };
}
