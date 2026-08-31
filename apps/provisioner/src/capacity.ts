import type { DocumentStore } from '@xaa/gcp';

export interface CapacityResult {
  allowed: boolean;
  active: number;
  capacity: number;
}

/**
 * DEC-IAC-23. The cap exists because of a GCP limit, not a cost one: a project
 * allows 100 service accounts by default and a deleted one keeps its slot for 30
 * days. Recycling agents every 24 hours would exhaust that within weeks.
 *
 * The count and the reservation happen in one transaction, so simultaneous requests
 * cannot both see room for the last slot.
 *
 * Nothing here quietly downgrades a request to STANDARD. The Policy Engine decided
 * full isolation was required; answering 503 is honest, silently running the agent
 * with less isolation is not.
 */
export async function reserveFullIsolationSlot(options: {
  documents: DocumentStore;
  agentId: string;
  capacity: number;
  expiresAt: string;
  now: () => number;
}): Promise<CapacityResult> {
  return options.documents.transaction(async (tx) => {
    // Destroyed agents are not counted: their service-account slots come back through
    // the sweep, and holding provisioning hostage to that is not this gate's job.
    const active = await tx.count('agents', [['isolation_level', 'full_isolation'], ['status', 'ACTIVE']]);
    if (active >= options.capacity) return { allowed: false, active, capacity: options.capacity };
    tx.set('dedicated_resources', options.agentId, {
      agent_id: options.agentId, status: 'CREATING', created: [],
      created_at: new Date(options.now()).toISOString(), expires_at: options.expiresAt, last_error: null,
    });
    return { allowed: true, active: active + 1, capacity: options.capacity };
  });
}
