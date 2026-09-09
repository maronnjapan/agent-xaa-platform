import type { Characteristics, DelegatableEntry } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { AUTHZ_COLLECTIONS } from '../store/collections.js';
import type { PermissionRecord } from './permission.js';

/** A permission with what the platform already does with it. */
export interface PermissionView extends PermissionRecord {
  /** Resources this permission is mapped to, by connector id (docs 04 §2). */
  connector_ids: string[];
  /** How many people hold it, and therefore how many agents could inherit it. */
  holders: number;
}

export class PermissionExists extends Error {
  readonly code = 'permission_exists';
  constructor(readonly capability_id: string) { super(`permission_exists: ${capability_id}`); }
}

export class PermissionInUse extends Error {
  readonly code = 'permission_in_use';
  constructor(readonly holders: number, readonly connector_ids: string[]) {
    super(`permission_in_use: ${holders} holders, ${connector_ids.length} resources`);
  }
}

export interface PermissionAdminStore {
  list(): Promise<PermissionView[]>;
  find(capabilityId: string): Promise<PermissionView | undefined>;
  create(permission: PermissionRecord): Promise<void>;
  update(permission: PermissionRecord): Promise<void>;
  /** Refuses while anyone holds the permission or a resource is mapped to it. */
  remove(capabilityId: string): Promise<void>;
}

interface TaxonomyDocument {
  capability_id: string;
  resource: string;
  object?: string;
  action: string;
  description: string;
  default_characteristics?: Partial<Characteristics>;
}

/**
 * The console's view of the permission tables (docs 03 §2).
 *
 * A permission is two documents: what the capability is (`capability_taxonomy`) and
 * whether it may be delegated to an agent (`delegatable_permissions`). They are
 * written in one transaction, because a taxonomy entry with no delegation row is not
 * a half-made permission — it is one that silently denies, and an administrator who
 * ticked the box would have no way to see why.
 *
 * Nothing here touches `human_permissions`. Who holds a permission is granted per
 * person with `pnpm perm:set`, which also announces the change so running agents are
 * re-evaluated (RULE-14); a console that wrote that table directly would grant
 * permissions no agent ever hears about.
 */
export function createPermissionAdminStore(documents: DocumentStore): PermissionAdminStore {
  const holderCounts = async (): Promise<Map<string, number>> => {
    const rows = await documents.listAll<{ capability_id: string }>(AUTHZ_COLLECTIONS.humanPermissions);
    const counts = new Map<string, number>();
    for (const { data } of rows) counts.set(data.capability_id, (counts.get(data.capability_id) ?? 0) + 1);
    return counts;
  };

  /**
   * Which resource each permission is mapped to, read the same way the Policy Engine
   * reads it (REQ-03-021): connector ids only. The API behind a connector belongs to
   * the Tool / Connector Catalog and stays out of this app (RULE-16).
   */
  const connectorsByCapability = async (): Promise<Map<string, string[]>> => {
    const rows = await documents.listAll<{ required_capability: string; connector_id: string }>(AUTHZ_COLLECTIONS.catalogTools);
    const map = new Map<string, string[]>();
    for (const { data } of rows) {
      const list = map.get(data.required_capability) ?? [];
      if (!list.includes(data.connector_id)) list.push(data.connector_id);
      map.set(data.required_capability, list.sort());
    }
    return map;
  };

  const delegatableEntries = async (): Promise<Map<string, DelegatableEntry>> => {
    const rows = await documents.listAll<DelegatableEntry>(AUTHZ_COLLECTIONS.delegatablePermissions);
    return new Map(rows.map(({ data }) => [data.capability_id, data]));
  };

  const view = (
    entry: TaxonomyDocument,
    delegatable: DelegatableEntry | undefined,
    connectors: Map<string, string[]>,
    holders: Map<string, number>,
  ): PermissionView => ({
    capability_id: entry.capability_id,
    resource: entry.resource,
    // Seeded rows all carry an object; a row that predates the field reads as its own.
    object: entry.object ?? entry.resource,
    action: entry.action,
    description: entry.description,
    default_characteristics: entry.default_characteristics ?? {},
    // Absence means not delegatable, which is what the Policy Engine also concludes.
    delegatable: delegatable?.delegatable === true,
    delegatable_policy_id: delegatable?.policy_id ?? `del-${entry.capability_id}`,
    connector_ids: connectors.get(entry.capability_id) ?? [],
    holders: holders.get(entry.capability_id) ?? 0,
  });

  const write = async (permission: PermissionRecord, mustBeNew: boolean): Promise<void> => {
    await documents.transaction(async (tx) => {
      const existing = await tx.get<TaxonomyDocument>(AUTHZ_COLLECTIONS.capabilityTaxonomy, permission.capability_id);
      if (mustBeNew && existing) throw new PermissionExists(permission.capability_id);
      tx.set(AUTHZ_COLLECTIONS.capabilityTaxonomy, permission.capability_id, {
        capability_id: permission.capability_id,
        resource: permission.resource,
        object: permission.object,
        action: permission.action,
        description: permission.description,
        default_characteristics: { ...permission.default_characteristics },
      });
      tx.set(AUTHZ_COLLECTIONS.delegatablePermissions, permission.capability_id, {
        capability_id: permission.capability_id,
        delegatable: permission.delegatable,
        policy_id: permission.delegatable_policy_id,
      });
    });
  };

  return {
    async list() {
      const [rows, delegatable, connectors, holders] = await Promise.all([
        documents.listAll<TaxonomyDocument>(AUTHZ_COLLECTIONS.capabilityTaxonomy),
        delegatableEntries(), connectorsByCapability(), holderCounts(),
      ]);
      return rows
        .map(({ data }) => view(data, delegatable.get(data.capability_id), connectors, holders))
        .sort((left, right) => left.capability_id.localeCompare(right.capability_id));
    },

    async find(capabilityId) {
      const entry = await documents.get<TaxonomyDocument>(AUTHZ_COLLECTIONS.capabilityTaxonomy, capabilityId);
      if (!entry) return undefined;
      const [delegatable, connectors, holders] = await Promise.all([
        delegatableEntries(), connectorsByCapability(), holderCounts(),
      ]);
      return view(entry, delegatable.get(capabilityId), connectors, holders);
    },

    create: (permission) => write(permission, true),
    update: (permission) => write(permission, false),

    /**
     * Removal is refused while the permission is in use, and the refusal says by what.
     *
     * Deleting a capability people still hold would leave `human_permissions` rows
     * pointing at nothing: the Policy Engine would drop them out of the taxonomy and
     * every decision would silently narrow, with no record saying a permission was
     * removed. The same goes for a resource still mapped to it, whose tool would
     * become unreachable for every agent.
     *
     * The check and the deletion are one transaction. Read first and delete after would
     * let a grant made in between be the grant that survives its own capability.
     */
    async remove(capabilityId) {
      await documents.transaction(async (tx) => {
        const held = await tx.count(AUTHZ_COLLECTIONS.humanPermissions, [['capability_id', capabilityId]]);
        const mapped = (await tx.queryEqual<{ connector_id: string }>(
          AUTHZ_COLLECTIONS.catalogTools, [['required_capability', capabilityId]],
        )).map(({ data }) => data.connector_id).sort();
        if (held > 0 || mapped.length > 0) throw new PermissionInUse(held, [...new Set(mapped)]);
        tx.delete(AUTHZ_COLLECTIONS.capabilityTaxonomy, capabilityId);
        tx.delete(AUTHZ_COLLECTIONS.delegatablePermissions, capabilityId);
      });
    },
  };
}
