import { Hono } from 'hono';
import {
  createCompletionCode, PLATFORM_CLIENT_ID, PROVISIONING_CODES_COLLECTION,
} from '@xaa/contracts';
import type { AgentOpDeps } from '../deps.js';
import { createAgentOpStore } from '../store/index.js';

interface ConsentStateRecord {
  transaction_id: string;
  agent_id: string;
  human_subject: string;
  code_verifier: string;
  idp_connection_id: string;
  expires_at: string;
  used: boolean;
}

/**
 * REQ-05-047 / REQ-05-048 / RULE-23. The browser leg of the offline_access consent.
 *
 * Nothing token-shaped ever reaches the browser: the redirect carries the
 * transaction id and a single-use code, the body is empty and no cookie is set. Only
 * the refresh token is kept; the access token and the ID Token from the exchange are
 * dropped on the floor.
 */
export function createXaaCallbackRoute(deps: AgentOpDeps, automationAppUrl: string): Hono {
  const store = createAgentOpStore(deps.documents, deps.config, () => deps.signer.kid);
  const httpFetch = deps.humanIdpFetch ?? globalThis.fetch;

  const app = new Hono();
  app.get('/', async (context) => {
    const state = context.req.query('state');
    const code = context.req.query('code');
    const error = context.req.query('error');
    if (!state) return failure('missing state');

    const record = await deps.documents.get<ConsentStateRecord>('bridge_consent_states', state);
    if (!record || record.used) return failure('state is not usable');
    // One-shot: consumed before anything else can fail, so a retry cannot replay it.
    await deps.documents.update('bridge_consent_states', state, { used: true });

    if (Date.parse(record.expires_at) <= (deps.now?.() ?? Date.now())) {
      await failTransaction(deps, record.transaction_id);
      return failure('the transaction expired');
    }

    if (error || !code) {
      await failTransaction(deps, record.transaction_id);
      return failure('authorization was not granted');
    }
    if (!record.code_verifier) {
      await failTransaction(deps, record.transaction_id);
      return failure('the transaction carries no PKCE verifier');
    }

    const response = await httpFetch(deps.config.humanIdpTokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${PLATFORM_CLIENT_ID}:${deps.config.clientSecretAgentPlatform}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri: `${deps.config.publicBaseUrl}/xaa/callback`,
        code_verifier: record.code_verifier,
      }).toString(),
    });
    if (!response.ok) {
      await failTransaction(deps, record.transaction_id);
      return failure('the authorization code could not be exchanged');
    }
    const body = await response.json() as { refresh_token?: string };
    if (!body.refresh_token) {
      await failTransaction(deps, record.transaction_id);
      return failure('no refresh token was returned');
    }

    await store.idpConnections.create({
      idp_connection_id: record.idp_connection_id,
      agent_id: record.agent_id,
      human_subject: record.human_subject,
      encrypted_refresh_token: await deps.envelope.encrypt(body.refresh_token, record.agent_id),
      granted_scopes: ['openid', 'offline_access'],
      status: 'ACTIVE',
      created_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      expires_at: record.expires_at,
    });

    // The transaction's status is the Provisioner's to move (00b §3): its resume route
    // is what takes WAITING_IDP_CONSENT to RESUMABLE, and moving it here first made
    // that transition illegal and every resume a 500. What makes this single-shot is
    // the consent state consumed above and the one-time code below, both of which are
    // spent exactly once.

    // The Provisioner redeems this, so it is written in the Provisioner's shape and in
    // the Provisioner's collection: only the hash is stored, and the row carries the
    // subject the redemption is checked against (T-PROV-15).
    const completion = await createCompletionCode({
      transactionId: record.transaction_id,
      humanSubject: record.human_subject,
      issuerKind: 'idp',
      now: deps.now?.(),
    });
    await deps.documents.set(PROVISIONING_CODES_COLLECTION, completion.documentId, { ...completion.record });

    const location = `${automationAppUrl}/provisioning/resume?transaction_id=${encodeURIComponent(record.transaction_id)}&code=${encodeURIComponent(completion.code)}`;
    return context.body(null, 302, { Location: location });
  });
  return app;
}

/** The failure page never echoes Human IdP's error_description. */
function failure(_reason: string): Response {
  void _reason;
  return new Response(
    '<!doctype html><meta charset="utf-8"><p>認可を完了できませんでした。管理画面からやり直してください。</p>',
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

async function failTransaction(deps: AgentOpDeps, transactionId: string): Promise<void> {
  await deps.documents.update('provisioning_transactions', transactionId, { status: 'FAILED' }).catch(() => undefined);
}
