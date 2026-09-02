import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HUMAN_IDP_ISSUER } from '../../harness/human-idp.js';
import { startResource, type ResourceHarness } from '../../harness/resource.js';
import { startAutomationAppHarness, type AutomationHarness } from '../../harness/automation-app.js';

// T-APP-05. The request that used to answer 401: the Automation App writes the
// daily report before any agent exists to delegate through, so it calls in with
// its own Cloud Run service identity rather than a DPoP-bound XAA Access Token.
// This spec drives that write against the real `resource-docs-api` app — the same
// `createApp()` Cloud Run runs — and confirms the internal writer T-APP-05 added is
// what makes the call succeed.
const AUTOMATION_APP_SA = 'sa-automation-app@xaa-test.iam.gserviceaccount.com';

async function dummyPublicJwk(): Promise<JsonWebKey> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return webcrypto.subtle.exportKey('jwk', pair.publicKey);
}

/**
 * The Document RS, wired for real, plus the Automation App wired to call it with
 * the app's own service identity — exactly the transport `docsAuthorization()` in
 * apps/automation-app/src/app.ts builds in production.
 *
 * Reading prior work logs from the Document RS (T-APP-04) is a separate, already
 * covered path; this harness hands the report builder one directly rather than
 * reproducing that read here, so the spec stays about what T-APP-05 changed: the
 * write.
 */
async function startDailyReportHarness(): Promise<{ docs: ResourceHarness; automation: AutomationHarness }> {
  const docs = await startResource({
    kind: 'docs',
    agentOpPublicJwk: await dummyPublicJwk(),
    trustedIdpIssuer: HUMAN_IDP_ISSUER,
    automationAppServiceAccount: AUTOMATION_APP_SA,
  });
  const automation = await startAutomationAppHarness({
    identityTokenProvider: async () => AUTOMATION_APP_SA,
    // Stands in for Vertex AI (T-APP-02's fake mode, driven directly rather than
    // through the model): this spec is about the write T-APP-05 added, not about
    // what a real model would write.
    generate: async <T,>() => ({ title: '9月1日の日報', body: '午前は資料作成、午後はレビュー対応をした。' } as T),
    signals: {
      async fetch() {
        return [{
          source_kind: 'work_log', occurred_at: '2026-09-01T09:00:00.000Z', human_subject: 'testuser',
          title: '9月1日の作業記録', body: '午前は資料作成、午後はレビュー対応をした。', metadata: {},
        }];
      },
    },
    upstream: (url, init) => (url.startsWith(docs.resourceUri)
      ? docs.api(url.slice(docs.resourceUri.length) || '/', init)
      : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  });
  return { docs, automation };
}

describe('the daily report, end to end', () => {
  it('creates exactly one daily_report document in the Document RS', async () => {
    const { docs, automation } = await startDailyReportHarness();

    const response = await automation.fetch('/api/reports/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-01T23:59:59.000Z' }),
    });

    expect(response.status).toBe(201);
    const created = await response.json() as { document_id: string };
    expect(created.document_id).toMatch(/^doc_/);

    // The write actually reached the real resource-docs-api app and landed there —
    // not a mock standing in for it.
    const stored = await docs.documents.get<{ type: string; owner_subject: string; title: string }>(
      'documents', created.document_id,
    );
    expect(stored).toMatchObject({ type: 'daily_report', owner_subject: automation.humanSubject });

    const daily = await docs.documents.queryEqual('documents', [['type', 'daily_report']]);
    expect(daily).toHaveLength(1);
    expect(daily[0]!.id).toBe(created.document_id);

    // The call used the app's own service identity, not a DPoP-bound Access Token.
    const write = automation.upstream.find(
      (call) => call.init.method === 'POST' && call.url === `${docs.resourceUri}/documents`,
    );
    expect((write?.init.headers as Record<string, string> | undefined)?.Authorization)
      .toBe(`Bearer ${AUTOMATION_APP_SA}`);
  });

  it('never opens a read: the same service identity gets 401 on GET /documents', async () => {
    const { docs } = await startDailyReportHarness();
    const response = await docs.api('/documents', { headers: { Authorization: `Bearer ${AUTOMATION_APP_SA}` } });
    expect(response.status).toBe(401);
  });
});
