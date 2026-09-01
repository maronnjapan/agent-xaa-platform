import type { CatalogConnector, ConnectorId, IsolationLevel } from '@xaa/contracts';
import type { Logger } from '@xaa/logging';

const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export class LogContainsToken extends Error {
  constructor() { super('log_contains_token'); }
}

/**
 * A connector is `READY` when the agent can already call it. Native connectors are
 * reached with the platform's own tokens and are therefore ready as soon as the tool
 * resolved; a bridged one needs a binding the person has consented to, and says so
 * until that exists.
 */
export type ConnectorState = 'READY' | 'CONSENT_REQUIRED' | 'NOT_CONNECTED';

export interface ProvisioningLogFields {
  event: 'provisioning_completed';
  agent_id: string;
  human_subject: string;
  transaction_id: string;
  isolation_level: IsolationLevel;
  dedicated_op: boolean;
  dedicated_short_id: string | null;
  provisioned_tools: string[];
  allowed_audiences: string[];
  resources: string[];
  scopes: string[];
  idp_connection_status: string;
  connector_states: Record<string, ConnectorState>;
  created_at: string;
  expires_at: string;
}

export function connectorStates(
  connectorIds: readonly ConnectorId[],
  connectors: readonly CatalogConnector[],
  bound: readonly string[] = [],
): Record<string, ConnectorState> {
  const byId = new Map(connectors.map((connector) => [connector.connector_id, connector]));
  return Object.fromEntries(connectorIds.map((connectorId) => {
    const connector = byId.get(connectorId);
    if (connector?.resource_type !== 'oauth_bridge') return [connectorId, 'READY' as ConnectorState];
    return [connectorId, bound.includes(connectorId) ? 'READY' : 'NOT_CONNECTED'];
  }));
}

/**
 * docs 09 §2. One line per completed provisioning, with everything an auditor needs to
 * say what this agent was allowed to do and what was built for it.
 *
 * The audiences, resources and scopes are flat rather than nested under the XAA config:
 * this line is read by a BigQuery query written against column names, and a nested
 * object turns three columns into one blob that has to be parsed before it can be
 * filtered.
 *
 * The token scan runs over the assembled line rather than over the fields that look
 * risky. Nothing here should ever carry a token, which is exactly why a value that does
 * has to stop the line rather than be trimmed out of it (RULE-38).
 */
export function buildProvisioningLog(input: Omit<ProvisioningLogFields, 'event'>): ProvisioningLogFields {
  const line: ProvisioningLogFields = { event: 'provisioning_completed', ...input };
  assertNoToken(line);
  return line;
}

export function logProvisioningCompleted(logger: Logger, line: ProvisioningLogFields): void {
  logger.info('provisioner.provision', {
    request_id: '', trace_id: `prov-${line.transaction_id}`, agent_id: line.agent_id, human_subject: line.human_subject,
  }, { ...line });
}

function assertNoToken(value: unknown, depth = 0): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    if (JWT_SHAPE.test(value)) throw new LogContainsToken();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoToken(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoToken(item, depth + 1);
  }
}
