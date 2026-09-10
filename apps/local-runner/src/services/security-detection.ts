import { createFirestoreDocumentStore } from '@xaa/gcp';
import { createSecurityDetection } from '@xaa/security-detection/app';
import { analyze } from '@xaa/security-detection/src/ai/vertex-client';
import { startPullLoop } from '@xaa/security-detection/src/ingest/subscriber';
import { listen, type Listener } from '../local/serve.js';
import { TOPICS, type LocalPlatform } from '../platform.js';

/**
 * The detector: it reads what every service logged, and decides whether anything is
 * wrong.
 *
 * It reaches exactly one other service — the Lifecycle Manager, and only to ask — and
 * that call goes out over HTTP with `sa-security`'s own identity, which is the account
 * the Lifecycle Manager's allow-list names. Nothing calls the detector: its ingestion is
 * a pull from the log topic, which the shared log sink fills (see `installLogSink`), so
 * a detection outage cannot become a platform outage (T-SEC-08).
 *
 * The BigQuery reconciliation is absent, and its absence is a real difference: the
 * signing-key-misuse batch joins the audit dataset against the ledger, and there is no
 * local dataset to join. Every other rule reads the same stream it reads on GCP.
 */
export function startSecurityDetection(platform: LocalPlatform): Listener {
  const publicBaseUrl = platform.config.topology.url['security-detection'];
  const identityToken = platform.identity.tokenProviderFor(platform.accounts.security!);
  const allowed = (accounts: readonly string[]) => async (token: string): Promise<string | null> => {
    const email = await platform.identity.verify(token, publicBaseUrl);
    return email !== null && accounts.includes(email) ? email : null;
  };

  const { app, runOnce } = createSecurityDetection({
    documents: createFirestoreDocumentStore(platform.firestore, 'security-detection'),
    sendToLifecycle: async (request) => {
      const url = new URL(
        `/internal/agents/${encodeURIComponent(request.agent_id)}/transition`,
        platform.config.topology.url.lifecycle,
      ).toString();
      const token = await identityToken(new URL(url).origin).catch(() => undefined);
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          to: request.to,
          reason: 'QUARANTINE',
          finding_id: request.finding_id,
          ...(request.to === 'QUARANTINED' ? { severity: 'CRITICAL' as const } : {}),
        }),
      });
    },
    analyze,
    financeResourceUrl: platform.config.topology.endpoints.resource_finance_api_url,
    maxLifetimeSeconds: platform.config.topology.agentMaxLifetimeSeconds,
    // Approving a quarantine is not the same right as delivering a log, so the two
    // lists are separate here as they are in Terraform.
    reviewerVerify: allowed([platform.accounts.security!, ...platform.config.adminPrincipals]),
    schedulerVerify: allowed([platform.accounts.scheduler!]),
    publishActivity: async (event) => { await platform.pubsub.publish(TOPICS.activity, event); },
  });

  startPullLoop(platform.pubsub.pullSubscription(TOPICS.securityLogs), async (payload) => { await runOnce([payload]); });

  return listen({
    name: 'security-detection',
    host: platform.config.topology.host,
    port: platform.config.topology.port['security-detection'],
    fetch: (request) => app.fetch(request),
  });
}
