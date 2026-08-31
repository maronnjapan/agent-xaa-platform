import { compile, catalogConnectorSchema, catalogToolSchema, type CatalogConnector, type CatalogTool } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

const assertTool: (value: unknown) => asserts value is CatalogTool = compile<CatalogTool>(catalogToolSchema);
const assertConnector: (value: unknown) => asserts value is CatalogConnector = compile<CatalogConnector>(catalogConnectorSchema);

/**
 * RULE-16. The catalogue is the only place that knows which API a capability maps
 * to. Nothing here writes: the seed job owns the data, and the Provisioner reads it.
 */
export interface CatalogRepository {
  tools(): Promise<CatalogTool[]>;
  connectors(): Promise<CatalogConnector[]>;
}

export function createCatalogRepository(documents: DocumentStore): CatalogRepository {
  return {
    async tools() {
      const rows = await documents.listAll<CatalogTool>('catalog_tools');
      for (const row of rows) assertTool(row.data);
      return rows.map(({ data }) => data);
    },
    async connectors() {
      const rows = await documents.listAll<CatalogConnector>('catalog_connectors');
      for (const row of rows) assertConnector(row.data);
      return rows.map(({ data }) => data);
    },
  };
}
