import { compile } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { BridgeError } from '../errors.js';
import { connectorDefinitionSchema, type ConnectorDefinition } from './types.js';

const assertConnector: (value: unknown) => asserts value is ConnectorDefinition =
  compile<ConnectorDefinition>(connectorDefinitionSchema);

export const CONNECTOR_CACHE_TTL_MS = 60_000;

export interface ConnectorRegistry {
  getConnector(connectorId: string): Promise<ConnectorDefinition>;
  findConnectorByResource(resource: string): Promise<ConnectorDefinition>;
}

/**
 * Reads connector definitions, and only reads them.
 *
 * There is no write function here. A connector is provisioned by seeding a row, which
 * means adding one needs no deploy — and means the Bridge cannot be talked into
 * inventing a destination for itself.
 *
 * The reverse lookup by resource matches whole strings. A prefix match would let a
 * connector claiming `https://api.example.com/` capture every resource beneath it,
 * including ones belonging to a connector added later.
 */
export function createConnectorRegistry(documents: DocumentStore, now: () => number = () => Date.now()): ConnectorRegistry {
  const cache = new Map<string, { value: ConnectorDefinition; readAt: number }>();

  const load = async (connectorId: string): Promise<ConnectorDefinition> => {
    const cached = cache.get(connectorId);
    if (cached && now() - cached.readAt < CONNECTOR_CACHE_TTL_MS) return cached.value;
    const row = await documents.get('connector_definitions', connectorId);
    if (!row) throw new BridgeError('invalid_target', 400);
    try {
      assertConnector(row);
    } catch {
      // A malformed definition is unusable, and guessing at it would mean sending a
      // client secret somewhere the schema never approved.
      throw new BridgeError('invalid_target', 400);
    }
    cache.set(connectorId, { value: row, readAt: now() });
    return row;
  };

  return {
    getConnector: load,
    async findConnectorByResource(resource) {
      const rows = await documents.listAll<ConnectorDefinition>('connector_definitions');
      const matches = rows
        .map((row) => row.data)
        .filter((definition) => Array.isArray(definition.resource_uris) && definition.resource_uris.includes(resource));
      // Zero and two are the same failure: in both cases the platform cannot say which
      // connector this request is for, and guessing is how a token reaches the wrong SaaS.
      if (matches.length !== 1) throw new BridgeError('invalid_target', 400);
      return load(matches[0]!.connector_id);
    },
  };
}
