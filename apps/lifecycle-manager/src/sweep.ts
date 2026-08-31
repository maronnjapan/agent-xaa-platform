import { assertRuntimeName } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { SWEEP_BATCH_SIZE, SWEEP_ORPHAN_LIMIT, TRANSACTION_TTL_SECONDS, type CleanupReason } from './config.js';
import { writeStatus } from './status-writer.js';
import { InvalidTransitionError, type AgentStatus } from './state-machine.js';
import type { CleanupOutcome } from './cleanup/result.js';

export interface SweepCounters {
  scanned: number;
  expiring: number;
  expired: number;
  retried: number;
  abandoned: number;
  orphans_deleted: number;
}

export interface LabelledResource {
  name: string;
  kind: 'cloud_run_service' | 'cloud_run_job' | 'service_account' | 'crypto_key';
  agentId: string | null;
}

export interface SweepDeps {
  documents: DocumentStore;
  expiringWindowSeconds: number;
  now?: () => number;
  cleanup(agentId: string, reason: CleanupReason): Promise<CleanupOutcome>;
  /** Everything labelled `xaa-managed=runtime`, whether or not the ledger knows it. */
  listLabelledResources?(): Promise<LabelledResource[]>;
  deleteResource?(resource: LabelledResource): Promise<void>;
}

interface AgentMeta {
  agent_id: string;
  status: AgentStatus;
  expires_at: string;
  cleanup_reason?: CleanupReason;
  cleanup_step_results?: Array<{ status: string }>;
}

/**
 * One pass over everything that might need attention.
 *
 * The five stages run in a fixed order because each depends on the last: warn, expire,
 * retry, abandon, then collect what nothing owns. An agent that expires in this tick is
 * cleaned in this tick; a step that failed in the last one is tried again in this one.
 *
 * There is no global lock. Concurrency is handled per agent by cleanup's own lock, so
 * two overlapping ticks divide the work rather than one of them doing nothing.
 */
export async function sweep(deps: SweepDeps): Promise<SweepCounters> {
  const now = deps.now ?? (() => Date.now());
  const counters: SweepCounters = { scanned: 0, expiring: 0, expired: 0, retried: 0, abandoned: 0, orphans_deleted: 0 };
  const nowMs = now();

  const rows = await deps.documents.queryRange<AgentMeta>('agents', 'agent_id', 'agent-', 'agent-￿');
  const agents = rows.map((row) => row.data).filter((meta) => typeof meta?.expires_at === 'string').slice(0, SWEEP_BATCH_SIZE);
  counters.scanned = agents.length;

  for (const meta of agents) {
    const expiresAt = Date.parse(meta.expires_at);

    // (a) About to expire: warn, but do not clean up yet.
    if (meta.status === 'ACTIVE' && expiresAt - nowMs > 0 && expiresAt - nowMs <= deps.expiringWindowSeconds * 1000) {
      await writeStatus({ documents: deps.documents, agentId: meta.agent_id, to: 'EXPIRING', now: nowMs }).catch(() => undefined);
      counters.expiring += 1;
      continue;
    }

    // (b) Expired. ACTIVE cannot go straight to EXPIRED, so the tick walks it through
    // EXPIRING first — two writes rather than a shortcut in the state machine.
    if (expiresAt <= nowMs && ['ACTIVE', 'EXPIRING', 'EXPIRED'].includes(meta.status)) {
      if (meta.status === 'ACTIVE') {
        await writeStatus({ documents: deps.documents, agentId: meta.agent_id, to: 'EXPIRING', now: nowMs }).catch(() => undefined);
      }
      await writeStatus({ documents: deps.documents, agentId: meta.agent_id, to: 'EXPIRED', now: nowMs }).catch((error) => {
        if (!(error instanceof InvalidTransitionError)) throw error;
      });
      await deps.cleanup(meta.agent_id, 'EXPIRED');
      counters.expired += 1;
      continue;
    }

    // (c) Unfinished cleanup, retried under its original reason — not relabelled as
    // EXPIRED, because why an agent was destroyed is part of the record.
    if (meta.status === 'REVOKED' && (meta.cleanup_step_results ?? []).some((entry) => entry.status === 'failed')) {
      await deps.cleanup(meta.agent_id, meta.cleanup_reason ?? 'EXPIRED');
      counters.retried += 1;
    }
  }

  // (d) Provisioning that nobody came back to finish.
  const transactions = await deps.documents.queryRange<{ status: string; created_at: string; agent_id?: string }>(
    'provisioning_transactions', 'created_at', '', '￿',
  ).catch(() => []);
  for (const row of transactions) {
    const stale = ['WAITING_EXTERNAL_CONSENT', 'WAITING_IDP_CONSENT', 'IN_PROGRESS', 'PROVISIONING'].includes(row.data.status)
      && nowMs - Date.parse(row.data.created_at) > TRANSACTION_TTL_SECONDS * 1000;
    if (!stale) continue;
    await deps.documents.update('provisioning_transactions', row.id, { status: 'ABANDONED' }).catch(() => undefined);
    counters.abandoned += 1;
    if (row.data.agent_id) await deps.cleanup(row.data.agent_id, 'EXPIRED').catch(() => undefined);
  }

  // (e) Resources whose agent is gone. This is the only path that can reach something
  // the Provisioner created but never managed to record — which is why the labels are
  // mandatory at creation time (DEC-IAC-25).
  if (deps.listLabelledResources && deps.deleteResource) {
    let deleted = 0;
    for (const resource of await deps.listLabelledResources()) {
      if (deleted >= SWEEP_ORPHAN_LIMIT) break;
      if (!resource.agentId) continue;
      const meta = await deps.documents.get<{ status?: string }>('agents', `${resource.agentId}__meta`);
      if (meta && meta.status !== 'DESTROYED') continue;
      assertRuntimeName(resource.name);
      await deps.deleteResource(resource);
      deleted += 1;
    }
    counters.orphans_deleted = deleted;
  }

  return counters;
}
