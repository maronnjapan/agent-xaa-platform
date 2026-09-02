import { Storage } from '@google-cloud/storage';
import { createHash } from 'node:crypto';
import {
  COLLECTIONS, compile, paymentSchema, paymentSeedSchema, platformEndpointsSchema,
  type PlatformEndpoints, type StoredPayment,
} from '@xaa/contracts';
import { getFirestore } from '@xaa/gcp';
import { parse } from 'yaml';
import { resolveSeedPlaceholders } from './resolve.js';
import { validateSeed, type CapabilitySeed, type ConnectorSeed, type HumanPermissionSeed, type ToolSeed } from './validate.js';

const DATA_COLLECTIONS = [
  COLLECTIONS.CATALOG_CONNECTORS, COLLECTIONS.CATALOG_TOOLS, COLLECTIONS.CAPABILITY_TAXONOMY,
  COLLECTIONS.HUMAN_PERMISSIONS, COLLECTIONS.DELEGATABLE_PERMISSIONS,
  COLLECTIONS.ORGANIZATION_POLICIES, COLLECTIONS.RISK_POLICIES,
] as const;

async function downloadJson(storage: Storage, uri: string): Promise<unknown> {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('invalid GCS URI');
  const [content] = await storage.bucket(match[1]!).file(match[2]!).download();
  return JSON.parse(content.toString('utf8'));
}

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
  const connectors = [...records].filter(([name]) => name.startsWith('connectors/')).map(([, value]) => value as ConnectorSeed)
    .filter((entry) => env.ENABLE_GOOGLE_BRIDGE === 'true' || entry.connector_id !== 'stub-saas-calendar');
  const tools = [...records].filter(([name]) => name.startsWith('tools/')).map(([, value]) => value as ToolSeed)
    .filter((entry) => env.ENABLE_GOOGLE_BRIDGE === 'true' || entry.connector_id !== 'stub-saas-calendar');
  const capabilities = (records.get('capabilities.yaml') as CapabilitySeed[] | undefined) ?? [];
  // The naming rule is checked before the deletion below: a taxonomy that would be
  // refused must not first empty the collections it was going to replace.
  const humanPermissions = (records.get('human-permissions.yaml') as HumanPermissionSeed[] | undefined) ?? [];
  validateSeed(connectors, tools, capabilities, humanPermissions);
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

/** A UUID-shaped id derived from the row, so `pay_` + 36 chars stays satisfied. */
function demoPaymentId(row: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(row)).digest('hex');
  return `pay_${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
