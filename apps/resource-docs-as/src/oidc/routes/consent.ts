import { Hono } from 'hono';
import {
  getAuthTransaction,
  validateCsrfToken,
  completeAuthTransaction,
  createAuthorizationCode,
} from '@maronn-openid-connect/core';
import {
  consentResolver as defaultConsentResolver,
} from '../resolvers.js';
import {
  transactionStore as defaultTransactionStore,
  authCodeStore as defaultAuthCodeStore,
  authSessionStore as defaultAuthSessionStore,
} from '../store.js';
import { defaultViews, renderView } from '../views.js';

export const consentApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Consent Page - GET
 * Displays the consent form for scope authorization.
 */
consentApp.get('/', async (c) => {
  const transactionId = c.req.query('transaction_id');
  if (!transactionId) {
    return c.text('Missing transaction_id', 400);
  }

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const transaction = await getAuthTransaction(transactionId, transactionStore);

  return renderView(views.consentPage({
    transactionId,
    csrfToken: transaction.csrfToken,
    scopes: transaction.scope.split(' ').filter(Boolean),
    clientId: transaction.clientId,
  }));
});

/**
 * Consent Handler - POST
 * Processes the consent decision.
 */
consentApp.post('/', async (c) => {
  const body = await c.req.parseBody();
  const transactionId = String(body['transaction_id'] ?? '');
  const csrfToken = String(body['csrf_token'] ?? '');
  const action = String(body['action'] ?? '');

  const views = c.get('views') ?? defaultViews;
  const transactionStore = c.get('transactionStore') ?? defaultTransactionStore;
  const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
  const authSessionStore = c.get('authSessionStore') ?? defaultAuthSessionStore;

  const transaction = await getAuthTransaction(transactionId, transactionStore);
  validateCsrfToken(transaction, csrfToken);

  // RFC 9207 §2: include the issuer identifier on every authorization response
  // (success and error) so clients can pin the issuer that produced the response.
  const config = c.get('config');
  const issuer = config.issuer;

  if (action === 'deny') {
    const redirectUrl = new URL(transaction.redirectUri);
    redirectUrl.searchParams.set('error', 'access_denied');
    if (transaction.state) {
      redirectUrl.searchParams.set('state', transaction.state);
    }
    redirectUrl.searchParams.set('iss', issuer);
    await transactionStore.delete('auth_txn:' + transactionId);
    await authSessionStore.delete(transactionId);
    return c.redirect(redirectUrl.toString());
  }

  // OIDC Core 1.0 Section 3.1.2.4: "the Authorization Server MUST obtain an
  // authorization decision before releasing information to the Relying Party."
  // The affirmative decision is therefore detected on an allowlist: a missing,
  // empty or unknown 'action' means no decision was obtained, so it must not
  // approve. Deciding by "not deny" would approve every unexpected value instead.
  //
  // 'approve' is the decision value this provider accepts, and it MUST stay in
  // sync with the Approve button in views.ts consentPage(). Changing it here
  // without changing the button (or the other way round) makes every approval
  // fail with the 400 below.
  //
  // Section 3.1.2.6: access_denied means the End-User denied the request, which
  // is not the same as no decision at all — an unrecognized value stops here on
  // the OP's own error page instead of being redirected back to the client.
  if (action !== 'approve') {
    return renderView(views.errorPage({
      error: 'Invalid consent decision. Please use the Approve or Deny button.',
      statusCode: 400,
    }), { status: 400 });
  }

  const session = await authSessionStore.get(transactionId);
  if (!session) {
    return renderView(views.errorPage({
      error: 'Authentication session not found. Please restart login.',
      statusCode: 400,
    }), { status: 400 });
  }

  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );

  // transaction.scope は認可リクエスト検証時に applyOfflineAccessPolicy を通した後の値。
  // offline_access の可否（OIDC Core 1.0 §11 の prompt=consent と、クライアント登録
  // grant_types に refresh_token があるか）はそこで確定しているので再フィルタしない。
  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // Generate authorization code via core helper
  // OIDC Core 1.0 Section 3.1.3.1: TTL is configurable via ProviderConfig
  // (defaults to 300 seconds — 5 minutes).
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // online refresh token をこのログインセッションへ束縛する（login route が
    // authSessionStore へ載せた値）。ログアウトすれば RT も使えなくなる。
    sessionId: session.sessionId,
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);

  // Record consent so a later prompt=none (or non-interactive SSO) request can
  // confirm it without UI (OIDC Core 1.0 Section 3.1.2.1 / 3.1.2.4). Routed
  // through the consentResolver so a custom store can override persistence.
  // Only the per-transaction handoff is cleared below; the browser (OP) session
  // persists so SSO keeps working.
  const consentResolver = c.get('consentResolver') ?? defaultConsentResolver;
  await consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);
  await consentResolver.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );

  await authSessionStore.delete(transactionId);

  // Redirect back to client with authorization code
  const redirectUrl = new URL(responseParams.redirectUri);
  redirectUrl.searchParams.set('code', authCodeData.code);
  if (responseParams.state) {
    redirectUrl.searchParams.set('state', responseParams.state);
  }
  redirectUrl.searchParams.set('iss', issuer);
  return c.redirect(redirectUrl.toString());
});
