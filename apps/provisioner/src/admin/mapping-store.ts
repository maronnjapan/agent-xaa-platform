import { COLLECTIONS, type CatalogConnector, type CatalogTool } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

/** One resource operation and the permission it currently answers to. */
export interface MappingRow {
  tool_id: string;
  connector_id: string;
  description: string;
  required_capability: string;
  method: string;
  path: string;
  risk_level: string;
}

/** A resource, as the console groups its operations. */
export interface ResourceGroup {
  connector_id: string;
  resource_type: string;
  status: string;
  risk_level: string;
  tools: MappingRow[];
}

export interface CapabilityRow {
  capability_id: string;
  description: string;
  tool_ids: string[];
}

export interface MappingOverview {
  resources: ResourceGroup[];
  capabilities: CapabilityRow[];
}

export interface MappingChange {
  tool_id: string;
  from: string;
  to: string;
}

export type ApplyResult =
  | { ok: true; changes: MappingChange[] }
  | { ok: false; unknownTools: string[]; unknownCapabilities: string[] };

export interface MappingStore {
  overview(): Promise<MappingOverview>;
  /** Points each named tool at the named capability. All or nothing. */
  apply(mappings: Record<string, string>): Promise<ApplyResult>;
}

/**
 * The capability-to-resource mapping (docs 04 §1), as an administrator changes it.
 *
 * This is the Provisioner's data by RULE-16 — the Authorization Platform decides in
 * capabilities and never learns which API is behind one — so the screen that edits it
 * belongs here rather than in the app that decides, and certainly not in Automation
 * App, which must hold no permission information at all (RULE-07).
 *
 * What can be edited is deliberately narrow: which capability a tool answers to. The
 * URL, method, scope and audience of a tool are not editable here and are not editable
 * anywhere at run time — an admin console that could point a tool at a new URL would be
 * the arbitrary-HTTP surface RULE-17 exists to prevent.
 */
export function createMappingStore(documents: DocumentStore): MappingStore {
  const readAll = async () => {
    const [connectors, tools, taxonomy] = await Promise.all([
      documents.listAll<CatalogConnector>(COLLECTIONS.CATALOG_CONNECTORS),
      documents.listAll<CatalogTool>(COLLECTIONS.CATALOG_TOOLS),
      documents.listAll<{ capability_id: string; description?: string }>(COLLECTIONS.CAPABILITY_TAXONOMY),
    ]);
    return {
      connectors: connectors.map(({ data }) => data),
      tools: tools.map(({ data }) => data),
      taxonomy: taxonomy.map(({ data }) => data),
    };
  };

  return {
    async overview() {
      const { connectors, tools, taxonomy } = await readAll();
      const byConnector = new Map<string, MappingRow[]>();
      for (const tool of [...tools].sort((left, right) => left.tool_id.localeCompare(right.tool_id))) {
        const row: MappingRow = {
          tool_id: tool.tool_id,
          connector_id: tool.connector_id,
          description: tool.description,
          required_capability: tool.required_capability,
          method: tool.api?.method ?? '',
          path: tool.api?.path ?? '',
          risk_level: tool.risk_level,
        };
        byConnector.set(tool.connector_id, [...(byConnector.get(tool.connector_id) ?? []), row]);
      }

      return {
        // A DISABLED connector is still listed: an operator who turned a resource off
        // still has to see what is mapped to it before turning it back on.
        resources: [...connectors]
          .sort((left, right) => left.connector_id.localeCompare(right.connector_id))
          .map((connector) => ({
            connector_id: connector.connector_id,
            resource_type: connector.resource_type,
            status: connector.status,
            risk_level: connector.risk_level,
            tools: byConnector.get(connector.connector_id) ?? [],
          })),
        capabilities: [...taxonomy]
          .sort((left, right) => left.capability_id.localeCompare(right.capability_id))
          .map((entry) => ({
            capability_id: entry.capability_id,
            description: entry.description ?? '',
            tool_ids: tools
              .filter((tool) => tool.required_capability === entry.capability_id)
              .map((tool) => tool.tool_id)
              .sort(),
          })),
      };
    },

    /**
     * Every named tool and capability has to exist before anything is written.
     *
     * A tool pointed at a capability the taxonomy does not define is a tool no
     * decision can ever reach: the Policy Engine drops what is not in the taxonomy, so
     * the resource would simply become unreachable, with the catalogue still claiming
     * otherwise. Rejecting the whole submission keeps the screen honest — a form that
     * half-applied would show a mapping nobody chose.
     */
    async apply(mappings) {
      const { tools, taxonomy } = await readAll();
      const byToolId = new Map<string, CatalogTool>(tools.map((tool) => [tool.tool_id, tool]));
      const known = new Set(taxonomy.map((entry) => entry.capability_id));

      const unknownTools = Object.keys(mappings).filter((toolId) => !byToolId.has(toolId)).sort();
      const unknownCapabilities = [...new Set(Object.values(mappings).filter((capability) => !known.has(capability)))].sort();
      if (unknownTools.length > 0 || unknownCapabilities.length > 0) {
        return { ok: false, unknownTools, unknownCapabilities };
      }

      // One transaction for the whole submission, and the `from` each row reports is
      // read inside it: a screen rendered a minute ago must not be able to report a
      // move that started from a mapping somebody else had already changed.
      let changes: MappingChange[] = [];
      await documents.transaction(async (tx) => {
        changes = [];
        const current = new Map<string, string>();
        for (const toolId of Object.keys(mappings)) {
          const row = await tx.get<CatalogTool>(COLLECTIONS.CATALOG_TOOLS, toolId);
          if (row) current.set(toolId, row.required_capability);
        }
        for (const [toolId, capability] of Object.entries(mappings)) {
          const from = current.get(toolId);
          if (from === undefined || from === capability) continue;
          changes.push({ tool_id: toolId, from, to: capability });
        }
        // Only `required_capability` moves. A `set` here would rewrite the whole row
        // from what the screen happened to render, which is how a connection detail
        // nobody edited goes missing.
        for (const change of changes) {
          tx.update(COLLECTIONS.CATALOG_TOOLS, change.tool_id, { required_capability: change.to });
        }
      });
      return { ok: true, changes };
    },
  };
}
