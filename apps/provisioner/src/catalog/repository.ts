import { compile, catalogConnectorSchema, catalogToolSchema, type CatalogConnector, type CatalogTool, type ConnectorId, type ToolId } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

const assertTool: (value: unknown) => asserts value is CatalogTool = compile<CatalogTool>(catalogToolSchema);
const assertConnector: (value: unknown) => asserts value is CatalogConnector = compile<CatalogConnector>(catalogConnectorSchema);

/**
 * RULE-16. The catalogue is the only place that knows which API a capability maps
 * to. Nothing here writes: the seed job owns the data, and the Provisioner reads it.
 *
 * A DISABLED connector and everything under it is invisible from here. Turning a
 * connector off is how an operator stops agents reaching a service; a repository that
 * still handed its tools out would put them in the manifest of every agent
 * provisioned after the switch was thrown.
 */
export interface CatalogRepository {
  tools(): Promise<CatalogTool[]>;
  connectors(): Promise<CatalogConnector[]>;
  findToolsByCapability(capability: string): Promise<CatalogTool[]>;
  findToolById(toolId: ToolId): Promise<CatalogTool | undefined>;
  findConnectorById(connectorId: ConnectorId): Promise<CatalogConnector | undefined>;
}

export function createCatalogRepository(documents: DocumentStore): CatalogRepository {
  const connectors = async (): Promise<CatalogConnector[]> => {
    const rows = await documents.listAll<CatalogConnector>('catalog_connectors');
    for (const row of rows) assertConnector(row.data);
    return rows.map(({ data }) => data).filter((connector) => connector.status === 'ACTIVE');
  };

  const tools = async (): Promise<CatalogTool[]> => {
    const rows = await documents.listAll<CatalogTool>('catalog_tools');
    for (const row of rows) assertTool(row.data);
    const enabled = new Set((await connectors()).map((connector) => connector.connector_id));
    return rows.map(({ data }) => data).filter((tool) => enabled.has(tool.connector_id));
  };

  return {
    tools,
    connectors,
    async findToolsByCapability(capability) {
      return (await tools()).filter((tool) => tool.required_capability === capability);
    },
    async findToolById(toolId) {
      return (await tools()).find((tool) => tool.tool_id === toolId);
    },
    async findConnectorById(connectorId) {
      return (await connectors()).find((connector) => connector.connector_id === connectorId);
    },
  };
}
