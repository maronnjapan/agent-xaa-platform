import type { DelegatableEntry } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { AUTHZ_COLLECTIONS, humanPermissionId } from '../store/collections.js';
import type { PermSetAction } from '../perm-set.js';

/** One capability, seen from the question "does this person hold it?". */
export interface HolderView {
  capability_id: string;
  description: string;
  delegatable: boolean;
  held: boolean;
  /** When it was granted, for a permission the person holds. */
  granted_at?: string;
}

/** A grant that changed nothing is reported rather than announced. */
export type HolderChange = 'granted' | 'revoked' | 'unchanged';

export interface HolderAdminStore {
  /** Every capability in the taxonomy, with whether this person holds it. */
  list(humanSubject: string): Promise<HolderView[]>;
  /** True when the taxonomy knows the capability, which is what makes it grantable. */
  exists(capabilityId: string): Promise<boolean>;
  set(humanSubject: string, capabilityId: string, action: PermSetAction, changedAt: string): Promise<HolderChange>;
}

interface TaxonomyDocument {
  capability_id: string;
  description: string;
}

interface HumanPermissionDocument {
  human_subject: string;
  capability_id: string;
  granted_at: string;
}

/**
 * Who holds which permission (docs 03 §2.1).
 *
 * `human_permissions` is one document per (subject, capability) pair precisely so that
 * losing a permission is the absence of a record rather than a flag some reader could
 * forget to check. A revocation is therefore the deletion of the row, and this store
 * writes nothing else — the taxonomy that says what a capability *is* belongs to the
 * permission console beside it.
 *
 * Writing the row is only half of a permission change. The other half is that agents
 * already running have to hear about it (RULE-14), which is why the route above this
 * re-evaluates rather than leaving the change for a Pub/Sub delivery that, for a console
 * inside the Authorization Platform itself, would be this service telling itself.
 */
export function createHolderAdminStore(documents: DocumentStore): HolderAdminStore {
  const heldBy = async (humanSubject: string): Promise<Map<string, string>> => {
    const rows = await documents.queryEqual<HumanPermissionDocument>(
      AUTHZ_COLLECTIONS.humanPermissions, [['human_subject', humanSubject]],
    );
    return new Map(rows.map(({ data }) => [data.capability_id, data.granted_at]));
  };

  return {
    async list(humanSubject) {
      const [taxonomy, delegatable, held] = await Promise.all([
        documents.listAll<TaxonomyDocument>(AUTHZ_COLLECTIONS.capabilityTaxonomy),
        documents.listAll<DelegatableEntry>(AUTHZ_COLLECTIONS.delegatablePermissions),
        heldBy(humanSubject),
      ]);
      const delegatableById = new Map(delegatable.map(({ data }) => [data.capability_id, data.delegatable === true]));
      return taxonomy
        .map(({ data }) => {
          const grantedAt = held.get(data.capability_id);
          return {
            capability_id: data.capability_id,
            description: data.description,
            // Absence means not delegatable, which is what the Policy Engine concludes.
            delegatable: delegatableById.get(data.capability_id) === true,
            held: grantedAt !== undefined,
            ...(grantedAt === undefined ? {} : { granted_at: grantedAt }),
          };
        })
        .sort((left, right) => left.capability_id.localeCompare(right.capability_id));
    },

    async exists(capabilityId) {
      return (await documents.get<TaxonomyDocument>(AUTHZ_COLLECTIONS.capabilityTaxonomy, capabilityId)) !== undefined;
    },

    /**
     * Grants or revokes one permission, and says whether anything moved.
     *
     * "Nothing moved" matters because the caller re-evaluates on a change: granting a
     * permission somebody already holds must not spend a re-evaluation, and revoking
     * one they never had must not tell their agents that their permissions narrowed.
     */
    async set(humanSubject, capabilityId, action, changedAt) {
      const documentId = humanPermissionId(humanSubject, capabilityId);
      const existing = await documents.get<HumanPermissionDocument>(AUTHZ_COLLECTIONS.humanPermissions, documentId);
      if (action === 'grant') {
        if (existing) return 'unchanged';
        await documents.set(AUTHZ_COLLECTIONS.humanPermissions, documentId, {
          human_subject: humanSubject, capability_id: capabilityId, granted_at: changedAt,
        });
        return 'granted';
      }
      if (!existing) return 'unchanged';
      await documents.delete(AUTHZ_COLLECTIONS.humanPermissions, documentId);
      return 'revoked';
    },
  };
}
