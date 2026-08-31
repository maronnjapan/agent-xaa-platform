import type { DocumentStore } from '@xaa/gcp';
import { cleanupAgent, type CleanupDeps } from './cleanup/index.js';
import { loadDomain } from './domain.js';
import { assertCapabilitiesSufficient, CapabilityInsufficientError } from './reprovision-guard.js';
import type { ProvisionerClient } from './clients/types.js';

export interface ReprovisionOutcome {
  result: 'reprovisioned' | 'aborted' | 'blocked';
  reason_code?: string;
  missing_capabilities?: string[];
  old_agent_id: string;
  new_agent_id?: string;
}

export const REPROVISION_BODY_KEYS = [
  'work_definition_id', 'human_subject', 'effective_capabilities',
  'isolation_level', 'inherited_expires_at', 'previous_agent_id',
] as const;

/**
 * Replaces an agent whose permissions changed, rather than editing it.
 *
 * RULE-14 and RULE-29: an agent's permissions are what it was created with. Narrowing
 * them in place would leave tokens already issued under the old set, and a running
 * process that believes it still has them. So the old agent is destroyed first, and
 * only then is a new one requested.
 *
 * The expiry is inherited, not recalculated. Otherwise every permission change would
 * quietly extend the agent's life, and a person could keep one alive indefinitely by
 * adjusting their own permissions.
 */
export async function reprovision(input: {
  agentId: string;
  newEffectiveCapabilities: string[];
  requiredCapabilities: string[];
  workDefinitionId: string;
  documents: DocumentStore;
  cleanup: CleanupDeps;
  provisioner: ProvisionerClient;
  provisionerUrl: string;
  now?: () => number;
}): Promise<ReprovisionOutcome> {
  const now = input.now ?? (() => Date.now());
  // Read before cleanup: step11 deletes the document these values live in.
  const domain = await loadDomain(input.documents, input.agentId);
  const inherited = {
    humanSubject: domain.human_subject,
    expiresAt: domain.expires_at,
    isolationLevel: domain.isolation_level,
  };

  const outcome = await cleanupAgent(input.agentId, 'REPROVISION', input.cleanup);
  if (outcome.status !== 'DESTROYED') {
    // The old agent is still partly alive. Creating the new one now would leave two
    // agents holding overlapping permissions for the same person.
    return { result: 'blocked', reason_code: 'reprovision_blocked_by_cleanup', old_agent_id: input.agentId };
  }

  try {
    assertCapabilitiesSufficient(input.requiredCapabilities, input.newEffectiveCapabilities);
  } catch (error) {
    if (error instanceof CapabilityInsufficientError) {
      await failTransaction(input.documents, input.workDefinitionId, error.missing_capabilities);
      return {
        result: 'aborted', reason_code: 'capability_insufficient',
        missing_capabilities: error.missing_capabilities, old_agent_id: input.agentId,
      };
    }
    throw error;
  }

  if (Date.parse(inherited.expiresAt) <= now()) {
    // Nothing to inherit: a new agent would have to be given fresh time, which is the
    // extension this function exists to avoid.
    return { result: 'aborted', reason_code: 'reprovision_expired', old_agent_id: input.agentId };
  }

  const response = await input.provisioner.reprovision({
    baseUrl: input.provisionerUrl,
    body: {
      work_definition_id: input.workDefinitionId,
      human_subject: inherited.humanSubject,
      effective_capabilities: input.newEffectiveCapabilities,
      isolation_level: inherited.isolationLevel,
      inherited_expires_at: inherited.expiresAt,
      previous_agent_id: input.agentId,
    },
  });
  const newAgentId = typeof response.body.agent_id === 'string' ? response.body.agent_id : undefined;
  return {
    result: 'reprovisioned', old_agent_id: input.agentId,
    ...(newAgentId ? { new_agent_id: newAgentId } : {}),
  };
}

async function failTransaction(documents: DocumentStore, workDefinitionId: string, missing: string[]): Promise<void> {
  const rows = await documents.queryEqual<{ status: string }>('provisioning_transactions', [
    ['work_definition_id', workDefinitionId],
  ]).catch(() => []);
  for (const row of rows) {
    if (row.data.status === 'COMPLETED' || row.data.status === 'FAILED') continue;
    await documents.update('provisioning_transactions', row.id, {
      status: 'FAILED', failure_code: 'capability_insufficient', missing_capabilities: missing,
    }).catch(() => undefined);
  }
}
