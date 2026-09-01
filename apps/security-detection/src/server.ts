import { serve } from '@hono/node-server';
import { PubSub } from '@google-cloud/pubsub';
import { readModes } from '@xaa/contracts';
import { verifyGoogleServiceIdentity } from '@xaa/crypto';
import { createFirestoreDocumentStore, createIdentityTokenProvider, getFirestore } from '@xaa/gcp';
import { BigQuery } from '@google-cloud/bigquery';
import { createSecurityDetection } from './index.js';
import { analyze } from './ai/vertex-client.js';
import { startPullLoop } from './ingest/subscriber.js';
import { runBatch, type MisuseRow, type RuleHitRow } from './batch/signing-key-misuse.js';

const documents = createFirestoreDocumentStore(getFirestore(readModes(process.env)), 'security-detection');
const allowedCallers = (process.env.ALLOWED_CALLER_SAS ?? '').split(',').filter(Boolean);
// Kept apart from the ingestion allow list: a service account that may deliver logs is
// not thereby allowed to approve a quarantine (T-SEC-35).
const allowedReviewers = (process.env.ALLOWED_REVIEW_SAS ?? '').split(',').filter(Boolean);
const allowedSchedulers = (process.env.ALLOWED_SCHEDULER_SAS ?? '').split(',').filter(Boolean);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? '';
const maxLifetimeSeconds = Number(process.env.AGENT_MAX_LIFETIME_SECONDS);
const projectId = process.env.PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
const auditDataset = process.env.SECURITY_AUDIT_DATASET ?? 'security_audit';

/**
 * The ledger reconciliation, against BigQuery. It exists only where a project id does:
 * without one there is no dataset to join, and the route stays absent rather than
 * answering 200 for a batch that queried nothing.
 */
function signingKeyMisuseRunner(): ((now: Date) => Promise<readonly RuleHitRow[]>) | undefined {
  if (!projectId) return undefined;
  const bigquery = new BigQuery({ projectId });
  return async (now: Date) => runBatch(now, {
    documents,
    query: async (sql, params) => {
      const [rows] = await bigquery.query({ query: sql, params, location: process.env.REGION });
      return rows as MisuseRow[];
    },
    insertRuleHits: async (rows) => {
      await bigquery.dataset(auditDataset).table('rule_hits').insert([...rows]);
    },
  }, projectId, auditDataset);
}

function verifyCaller(allowed: readonly string[]): (token: string) => Promise<string | null> {
  return async (token: string) => {
    const claims = await verifyGoogleServiceIdentity(token, { audience: publicBaseUrl });
    const email = typeof claims.email === 'string' ? claims.email : '';
    return allowed.includes(email) ? email : null;
  };
}

const identityToken = createIdentityTokenProvider();
const signingKeyMisuse = signingKeyMisuseRunner();

const { app, runOnce } = createSecurityDetection({
  documents,
  /**
   * The one outbound destination this service has, addressed the way the Lifecycle
   * Manager serves it: `/internal/agents/{agent_id}/transition`, gated on a Google
   * OIDC token for `sa-security`, with the body its schema accepts (00b §4). All three
   * were wrong here, so the detector could decide to quarantine an agent and nothing
   * would happen.
   */
  sendToLifecycle: async (request) => {
    const base = process.env.LIFECYCLE_MANAGER_URL ?? '';
    const url = new URL(
      `/internal/agents/${encodeURIComponent(request.agent_id)}/transition`,
      base,
    ).toString();
    const token = await identityToken(new URL(url).origin).catch(() => undefined);
    return globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        to: request.to,
        // The cleanup reason, not the finding type: the far side groups its work by it.
        reason: 'QUARANTINE',
        finding_id: request.finding_id,
        ...(request.to === 'QUARANTINED' ? { severity: 'CRITICAL' as const } : {}),
      }),
    });
  },
  analyze,
  ...(process.env.RESOURCE_FINANCE_API_URL ? { financeResourceUrl: process.env.RESOURCE_FINANCE_API_URL } : {}),
  // DEC-IAC-16's ceiling is the only source for the lifetime rules; an unset variable
  // leaves the age check silent rather than inventing a default nobody chose.
  ...(Number.isFinite(maxLifetimeSeconds) && maxLifetimeSeconds > 0 ? { maxLifetimeSeconds } : {}),
  // Only the push delivery mode needs a caller check, and only then is one configured:
  // without it the push route stays closed.
  ...(allowedCallers.length > 0 ? { callerVerify: verifyCaller(allowedCallers) } : {}),
  ...(allowedReviewers.length > 0 ? { reviewerVerify: verifyCaller(allowedReviewers) } : {}),
  ...(allowedSchedulers.length > 0 ? { schedulerVerify: verifyCaller(allowedSchedulers) } : {}),
  ...(signingKeyMisuse ? { runSigningKeyMisuse: signingKeyMisuse } : {}),
});

/**
 * Pull, not push (DEC-SEC-03). The subscription is named by Terraform and handed over in
 * the environment; without it this service would start, answer /healthz, and quietly
 * read nothing — which is the one failure mode a detector must not have.
 */
const subscriptionName = process.env.SECURITY_EVENTS_SUBSCRIPTION;
if (!subscriptionName) throw new Error('SECURITY_EVENTS_SUBSCRIPTION is required');
if (process.env.SECURITY_EVENTS_DELIVERY !== 'push') {
  startPullLoop(new PubSub().subscription(subscriptionName), async (payload) => { await runOnce([payload]); });
}

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
