import type { DocumentStore, DocumentTransaction } from '@xaa/gcp';
import type { DedicatedResourceRecord } from './dedicated-ledger.js';

export interface CapacityResult {
  allowed: boolean;
  active: number;
  capacity: number;
}

/**
 * The register of who currently holds a FULL_ISOLATION slot.
 *
 * It lives in `dedicated_resources` because 00b §3 gives that collection the whole
 * subject of dedicated capacity and forbids a second one for the slots, and it is a
 * single document because the reservation has to have exactly one contention point:
 * counting rows instead would let two requests both read "one slot left" and both take
 * it, since a row neither of them read yet cannot conflict with either.
 *
 * The holder list is pruned against the ledger on every reservation, so a slot comes
 * back when Lifecycle releases the resources without this service having to be told.
 */
export const SLOT_REGISTER_ID = '_slots';

interface SlotRegister { holders: string[] }

/**
 * A slot is held for as long as GCP resources exist under it, not for as long as the
 * agent does. A provisioning that failed before it created anything therefore gives
 * its slot back immediately, while one that failed halfway keeps it until Lifecycle
 * has deleted what the ledger lists.
 */
async function stillHolding(tx: DocumentTransaction, agentId: string): Promise<boolean> {
  const record = await tx.get<DedicatedResourceRecord>('dedicated_resources', agentId);
  if (!record || record.status === 'RELEASED') return false;
  if (record.status === 'FAILED') return record.created.some((entry) => !entry.deleted_at);
  return true;
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
    const register = await tx.get<SlotRegister>('dedicated_resources', SLOT_REGISTER_ID);
    const holders: string[] = [];
    for (const holder of register?.holders ?? []) {
      if (holder !== options.agentId && await stillHolding(tx, holder)) holders.push(holder);
    }
    if (holders.length >= options.capacity) {
      return { allowed: false, active: holders.length, capacity: options.capacity };
    }
    // Written in the same transaction as the count: the register is what the next
    // request reads, so a reservation that is not visible to it is not a reservation.
    tx.set('dedicated_resources', SLOT_REGISTER_ID, { holders: [...holders, options.agentId] });
    tx.set('dedicated_resources', options.agentId, {
      agent_id: options.agentId, status: 'CREATING', created: [],
      created_at: new Date(options.now()).toISOString(), expires_at: options.expiresAt, last_error: null,
    } satisfies DedicatedResourceRecord);
    return { allowed: true, active: holders.length + 1, capacity: options.capacity };
  });
}
