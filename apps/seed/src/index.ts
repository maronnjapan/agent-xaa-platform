import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import {
  COLLECTIONS, compile, documentSchema, documentSeedSchema, paymentSchema, paymentSeedSchema,
  platformEndpointsSchema, type PlatformEndpoints, type StoredDocument, type StoredPayment,
} from '@xaa/contracts';
import { getFirestore } from '@xaa/gcp';
import { parse } from 'yaml';
import { BRIDGED_CONNECTOR_ID, CONNECTOR_DEFINITIONS, bridgeConnectorDefinitions } from './connector-definitions.js';
import { resolveSeedPlaceholders } from './resolve.js';
import { validateSeed, type CapabilitySeed, type ConnectorSeed, type HumanPermissionSeed, type ToolSeed } from './validate.js';

const DATA_COLLECTIONS = [
  COLLECTIONS.CATALOG_CONNECTORS, COLLECTIONS.CATALOG_TOOLS, COLLECTIONS.CAPABILITY_TAXONOMY,
  COLLECTIONS.HUMAN_PERMISSIONS, COLLECTIONS.DELEGATABLE_PERMISSIONS,
  COLLECTIONS.ORGANIZATION_POLICIES, COLLECTIONS.RISK_POLICIES, CONNECTOR_DEFINITIONS,
] as const;

async function downloadJson(storage: Storage, uri: string): Promise<unknown> {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('invalid GCS URI');
  const [content] = await storage.bucket(match[1]!).file(match[2]!).download();
  return JSON.parse(content.toString('utf8'));
}

/**
 * DEC-SCOPE-04. The Bridge is off by default, and a catalogue row for a connector
 * nobody serves is worse than a missing one: the Provisioner would resolve
 * `calendar.event.read` into a tool, put it in an agent's manifest, and the agent would
 * discover at its first call that no Bridge exists. The row is left out rather than
 * written and marked, because there is no field in the stored shape (00b §3) that would
 * carry the distinction to every reader.
 */
export function withoutBridgedRows<T extends { connector_id: string }>(rows: T[], bridgeEnabled: boolean): T[] {
  return bridgeEnabled ? rows : rows.filter((row) => row.connector_id !== BRIDGED_CONNECTOR_ID);
}

export { BRIDGED_CONNECTOR_ID } from './connector-definitions.js';

export async function runSeed(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.SEED_BUCKET || !env.PLATFORM_ENDPOINTS_URI) throw new Error('seed environment is incomplete');
  const storage = new Storage();
  const endpoints = await downloadJson(storage, env.PLATFORM_ENDPOINTS_URI);
  const validateEndpoints: (value: unknown) => asserts value is PlatformEndpoints = compile(platformEndpointsSchema);
  validateEndpoints(endpoints);
  const [files] = await storage.bucket(env.SEED_BUCKET).getFiles({ prefix: 'seed/' });
  const records = new Map<string, unknown>();
  for (const file of files.filter((entry) => entry.name.endsWith('.yaml'))) {
    const [content] = await file.download();
    records.set(file.name.replace(/^seed\//, ''), parse(resolveSeedPlaceholders(content.toString('utf8'), endpoints)));
  }
  const bridged = env.ENABLE_GOOGLE_BRIDGE === 'true';
  const connectors = withoutBridgedRows(
    [...records].filter(([name]) => name.startsWith('connectors/')).map(([, value]) => value as ConnectorSeed), bridged,
  );
  const tools = withoutBridgedRows(
    [...records].filter(([name]) => name.startsWith('tools/')).map(([, value]) => value as ToolSeed), bridged,
  );
  const capabilities = (records.get('capabilities.yaml') as CapabilitySeed[] | undefined) ?? [];
  // The naming rule is checked before the deletion below: a taxonomy that would be
  // refused must not first empty the collections it was going to replace.
  const humanPermissions = (records.get('human-permissions.yaml') as HumanPermissionSeed[] | undefined) ?? [];
  validateSeed(connectors, tools, capabilities, humanPermissions);
  // Resolved here, before Firestore is opened: a missing client id must not first empty
  // the collections the rows below were going to replace.
  const connectorDefinitions = bridgeConnectorDefinitions(env, endpoints);
  const firestore = getFirestore({ signer: 'kms', vertex: 'live', pubsub: 'gcp', store: 'gcp' }, env);
  for (const collection of DATA_COLLECTIONS) {
    const snapshots = await firestore.collection(collection).listDocuments();
    for (let offset = 0; offset < snapshots.length; offset += 400) {
      const batch = firestore.batch();
      for (const ref of snapshots.slice(offset, offset + 400)) batch.delete(ref);
      await batch.commit();
    }
  }
  const writes: Array<[string, string, unknown]> = [
    ...connectors.map((entry) => [COLLECTIONS.CATALOG_CONNECTORS, entry.connector_id, entry] as [string, string, unknown]),
    ...tools.map((entry) => [COLLECTIONS.CATALOG_TOOLS, entry.tool_id, entry] as [string, string, unknown]),
    ...connectorDefinitions.map((entry) => [CONNECTOR_DEFINITIONS, entry.connector_id, entry] as [string, string, unknown]),
  ];
  for (const entry of capabilities) writes.push([COLLECTIONS.CAPABILITY_TAXONOMY, entry.capability_id, entry]);
  // One document per (subject, capability), keyed the way the Provisioner and the
  // Authorization Platform read it back (00b §3). Without these rows every decision
  // would intersect with an empty permission set and grant nothing.
  for (const entry of humanPermissions) {
    writes.push([COLLECTIONS.HUMAN_PERMISSIONS, `${entry.human_subject}__${entry.capability_id}`, {
      human_subject: entry.human_subject, capability_id: entry.capability_id,
      granted_at: entry.granted_at ?? new Date().toISOString(),
    }]);
  }
  for (const entry of (records.get('policies/delegatable.yaml') as Array<{ capability_id: string }> ?? [])) writes.push([COLLECTIONS.DELEGATABLE_PERMISSIONS, entry.capability_id, entry]);
  for (const entry of (records.get('policies/organization.yaml') as Array<{ policy_id: string }> ?? [])) writes.push([COLLECTIONS.ORGANIZATION_POLICIES, entry.policy_id, entry]);
  for (const entry of (records.get('policies/risk.yaml') as Array<{ policy_id: string }> ?? [])) writes.push([COLLECTIONS.RISK_POLICIES, entry.policy_id, entry]);
  for (const payment of demoPayments(records.get('payments-demo.yaml'))) writes.push([COLLECTIONS.PAYMENTS, payment.payment_id, payment]);
  for (const document of demoDocuments(records.get('documents-demo.yaml'))) writes.push([COLLECTIONS.DOCUMENTS, document.document_id, document]);
  for (let offset = 0; offset < writes.length; offset += 400) {
    const batch = firestore.batch();
    for (const [collection, id, value] of writes.slice(offset, offset + 400)) batch.set(firestore.collection(collection).doc(id), value as Record<string, unknown>);
    await batch.commit();
  }
}

const assertPaymentSeed: (value: unknown) => void = compile(paymentSeedSchema);
const assertPayment: (value: unknown) => asserts value is StoredPayment = compile<StoredPayment>(paymentSchema);

/**
 * The demo payments an agent is meant to approve (T-RES-16). `payments` is not in the
 * purge list, so the id has to be stable: it is derived from the row's own content,
 * which makes a re-seed rewrite the same documents instead of adding new ones.
 *
 * The three approval fields are written as null here and only ever filled by the
 * approval path — the seed input schema does not even carry them.
 */
export function demoPayments(rows: unknown, createdAt = new Date().toISOString()): StoredPayment[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    assertPaymentSeed(row);
    const payment = {
      payment_id: demoPaymentId(row as Record<string, unknown>),
      ...(row as Record<string, unknown>),
      status: 'pending_approval',
      approved_by: null,
      approved_by_agent: null,
      approved_at: null,
      created_at: createdAt,
    };
    assertPayment(payment);
    return payment;
  });
}

const assertDocumentSeed: (value: unknown) => void = compile(documentSeedSchema);
const assertDocument: (value: unknown) => asserts value is StoredDocument = compile<StoredDocument>(documentSchema);

/**
 * The documents a demo starts with (T-APP-04). Nothing else can put one here: a
 * document is created either by an agent holding a delegated token or by the Automation
 * App writing a report it generated, and neither has happened on a project that has just
 * been applied. Without these rows "自動化できそうな作業を探す" reads an empty shelf, and
 * the flow the guide describes has no first step.
 *
 * `documents` is not in the purge list above, so the id has to be stable: it is derived
 * from the row's own content, which makes a re-seed rewrite the same documents instead of
 * adding a second copy of each.
 *
 * `occurred_days_ago` is resolved against the moment the Job runs rather than baked into
 * the file, so a re-seed moves the samples back inside the seven days the suggestion form
 * looks at by default. The row keeps its id across that move because the id is derived
 * from the unresolved row.
 */
export function demoDocuments(rows: unknown, createdAt = new Date().toISOString()): StoredDocument[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    assertDocumentSeed(row);
    const { occurred_days_ago: daysAgo, ...rest } = row as Record<string, unknown>;
    const document = {
      document_id: stableId('doc', row as Record<string, unknown>),
      ...rest,
      occurred_at: new Date(Date.parse(createdAt) - Number(daysAgo) * 86_400_000).toISOString(),
      metadata: {},
      created_at: createdAt,
      updated_at: createdAt,
      version: 1,
    };
    assertDocument(document);
    return document;
  });
}

/** A UUID-shaped id derived from the row, so `<prefix>_` + 36 chars stays satisfied. */
function stableId(prefix: string, row: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
  return `${prefix}_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function demoPaymentId(row: Record<string, unknown>): string {
  return stableId('pay', row);
}
