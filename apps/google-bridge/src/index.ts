import { Hono } from 'hono';
import { assertNoTokenInRedirect } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { createLogger, type LogContext, type Logger } from '@xaa/logging';
import type { JtiStore } from '@xaa/crypto';
import type { BridgeConfig } from './config.js';
import { BridgeError } from './errors.js';
import { createConnectorRegistry, type ConnectorRegistry } from './connectors/registry.js';
import { createConnectionStore, connectionId, normalizeScopes, type ConnectionStore } from './store/connection.js';
import { createBindingStore, type BindingStore } from './store/binding.js';
import { createConsentStore, type ConsentStore } from './consent/state-store.js';
import { createPkce, newState } from './consent/pkce.js';
import { createJwksCache } from './idjag/jwks-cache.js';
import { verifyBridgeIdJag } from './idjag/verify.js';
import { verifyCnfBinding } from './dpop/cnf-binding.js';
import { resolveBinding } from './token/resolve-binding.js';
import { resolveEffectiveScope, difference, isSubset, parseScope } from './token/effective-scope.js';
import { buildTokenResponse } from './token/response.js';
import { runRefreshGrant, type SecretReader } from './saas/refresh-grant.js';
import { createConnectorCipher, type KmsCipher } from './kms/connector-cipher.js';
import { allowedHostsFor, createBridgeFetch, type Send } from './http/outbound.js';
import { callerAuthz, type CallerAuthzOptions } from './middleware/caller-authz.js';
import { emitBridgeTokenLog, emitCallbackLog, emitProtocolValidation, type BridgeTokenLog } from './log/bridge-log.js';
import { JWT_BEARER_GRANT_TYPE } from '@xaa/contracts';

export interface BridgeDeps {
  config: BridgeConfig;
  documents: DocumentStore;
  jtiStore: JtiStore;
  kms: KmsCipher;
  readSecret: SecretReader;
  send?: Send;
  logger?: Logger;
  now?: () => number;
  callerVerify?: CallerAuthzOptions['verify'];
  /** Reads a provisioning transaction; the Bridge never creates one. */
  readTransaction?(transactionId: string): Promise<{ status: string; human_subject: string; required_scopes: string[] } | undefined>;
}

interface Wiring {
  connectors: ConnectorRegistry;
  connections: ConnectionStore;
  bindings: BindingStore;
  consent: ConsentStore;
  logger: Logger;
  now: () => number;
  bridgeFetch: ReturnType<typeof createBridgeFetch>;
  logContext: LogContext;
}

function wire(deps: BridgeDeps): Wiring {
  const now = deps.now ?? (() => Date.now());
  return {
    connectors: createConnectorRegistry(deps.documents, now),
    connections: createConnectionStore(deps.documents),
    bindings: createBindingStore(deps.documents),
    consent: createConsentStore(deps.documents, now),
    logger: deps.logger ?? createLogger('google-bridge', 'google_bridge'),
    now,
    bridgeFetch: createBridgeFetch(deps.send),
    logContext: { request_id: 'bridge', trace_id: 'bridge', agent_id: null, human_subject: null },
  };
}

function callerOptions(deps: BridgeDeps, wiring: Wiring): CallerAuthzOptions {
  return {
    audience: deps.config.bridgeInternalBaseUrl,
    serviceAccounts: {
      runtime: [deps.config.callerSaRuntime, ...deps.config.callerSaSlots].filter(Boolean),
      provisioner: [deps.config.callerSaProvisioner].filter(Boolean),
      lifecycle: [deps.config.callerSaLifecycle].filter(Boolean),
    },
    ...(deps.callerVerify ? { verify: deps.callerVerify } : {}),
    onForbidden: (email) => emitProtocolValidation(wiring.logger, wiring.logContext, 'forbidden_bridge_caller', { caller: email }),
  };
}

/**
 * The internal face: seven routes, reachable only by named service accounts.
 *
 * Nothing here renders a page and nothing here follows a redirect. A browser that
 * somehow reached this service would find no route it could use.
 */
export function createInternalApp(deps: BridgeDeps): Hono {
  const wiring = wire(deps);
  const authz = callerOptions(deps, wiring);
  const app = new Hono();
  const jwks = createJwksCache({ url: deps.config.jwksUrl, ...(deps.send ? { fetchImpl: deps.send } : {}), now: wiring.now });
  const cipher = createConnectorCipher({ kms: deps.kms, keyName: deps.config.connectorEncryptionKey });

  app.get('/livez', (context) => context.json({ status: 'ok', app: 'google-bridge' }));

  app.post('/token', callerAuthz(['runtime'], authz), async (context) => {
    // Seven fields, every one of them filled in — including for a request that stops at
    // the first check. `skipped` is a fact; a missing field is a question.
    const log: BridgeTokenLog = {
      id_jag_iss: 'skipped', id_jag_verify_result: 'skipped', connection_id: 'skipped',
      requested_resource: 'skipped', requested_scope: 'skipped',
      agent_expiry_check: 'skipped', google_refresh_result: 'skipped', access_token_issue_result: 'denied',
    };
    try {
      const form = await context.req.parseBody() as Record<string, string>;
      if (form.grant_type !== JWT_BEARER_GRANT_TYPE) {
        return context.json({ error: 'unsupported_grant_type' }, 400);
      }

      const verified = await verifyBridgeIdJag({
        params: form,
        jwks: await jwks.get(),
        sharedIssuer: deps.config.sharedIssuer,
        expectedAudience: deps.config.bridgeInternalBaseUrl,
      });
      log.id_jag_iss = verified.issuer;
      log.id_jag_verify_result = 'ok';
      log.requested_resource = verified.resource;
      log.requested_scope = verified.scope;

      await verifyCnfBinding({
        request: context.req.raw, verified, jtiStore: deps.jtiStore,
        expectedHtu: `${deps.config.bridgeInternalBaseUrl}/token`, now: wiring.now,
      });

      const resolved = await resolveBinding({
        verified, bindings: wiring.bindings, connections: wiring.connections,
        connectors: wiring.connectors, now: new Date(wiring.now()),
        onValidation: (validation, fields) => {
          log.agent_expiry_check = validation === 'expired_bridge_connection' ? 'expired_binding' : 'ok';
          emitProtocolValidation(wiring.logger, wiring.logContext, validation, fields);
        },
      });
      log.connection_id = resolved.connection.connection_id;
      log.agent_expiry_check = 'ok';

      const scope = resolveEffectiveScope({
        requestedScope: form.scope,
        idJagScope: verified.scope,
        bindingScopes: resolved.binding.scopes,
        connectionScopes: resolved.connection.granted_scopes,
        onViolation: (fields) => emitProtocolValidation(wiring.logger, wiring.logContext, 'bridge_scope_violation', fields),
      });

      const connector = await wiring.connectors.getConnector(resolved.connectorId);
      const grant = await runRefreshGrant({
        connector,
        refreshToken: await cipher.decryptRefreshToken(resolved.connection.encrypted_refresh_token),
        scope,
        readSecret: deps.readSecret,
        bridgeFetch: wiring.bridgeFetch,
        allowedHosts: allowedHostsFor({ connector, jwksUrl: deps.config.jwksUrl }),
      }).catch(async (error: unknown) => {
        if (error instanceof BridgeError && error.code === 'connection_revoked') {
          await wiring.connections.setStatus(resolved.connection.connection_id, 'REVOKED');
          log.google_refresh_result = 'revoked';
        } else {
          log.google_refresh_result = 'error';
        }
        throw error;
      });

      if (grant.newRefreshToken) {
        await wiring.connections.saveEncryptedRefreshToken(
          resolved.connection.connection_id,
          await cipher.encryptRefreshToken(grant.newRefreshToken),
        );
      }
      log.google_refresh_result = grant.rotated ? 'rotated' : 'ok';

      // The remaining life of the delegation, never more than the SaaS allows.
      const remaining = Math.floor((resolved.effectiveExpiry - wiring.now()) / 1000);
      const body = buildTokenResponse({
        accessToken: grant.accessToken,
        expiresIn: Math.max(1, Math.min(grant.expiresIn, remaining)),
        scope,
      });
      log.access_token_issue_result = 'issued';
      return context.json(body, 200);
    } catch (error) {
      if (error instanceof BridgeError) return context.json({ error: error.code }, error.status as 400);
      return context.json({ error: 'invalid_grant' }, 400);
    } finally {
      emitBridgeTokenLog(wiring.logger, wiring.logContext, log, { production: true });
    }
  });

  app.post('/connections/check', callerAuthz(['provisioner'], authz), async (context) => {
    const body = await context.req.json().catch(() => undefined) as {
      connector_id?: string; human_subject?: string; required_scopes?: string[];
    } | undefined;
    if (!body || Object.keys(body).length !== 3 || typeof body.connector_id !== 'string'
      || typeof body.human_subject !== 'string' || !Array.isArray(body.required_scopes)) {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const transactionId = context.req.header('X-Transaction-Id') ?? '';
    const id = connectionId(body.connector_id, body.human_subject);
    const connection = await wiring.connections.find(id);
    const required = new Set(body.required_scopes);
    const granted = new Set(connection?.granted_scopes ?? []);
    const usable = connection?.status === 'ACTIVE'
      && Date.parse(connection.expires_at) > wiring.now()
      && isSubset(required, granted);
    if (usable) {
      // The second agent for the same person needs no browser at all (REQ-06-018).
      return context.json({ status: 'READY', connection_id: id }, 200);
    }
    return context.json({
      status: 'CONSENT_REQUIRED',
      consent_url: `${deps.config.bridgeCallbackBaseUrl}/${body.connector_id}/oauth/start?transaction_id=${encodeURIComponent(transactionId)}`,
      // Only the difference: returning everything required would ask the person to
      // re-approve what they already granted.
      missing_scopes: difference(required, granted),
    }, 200);
  });

  app.post('/connections/verify', callerAuthz(['provisioner'], authz), async (context) => {
    const body = await context.req.json().catch(() => undefined) as {
      transaction_id?: string; one_time_code?: string;
    } | undefined;
    if (!body || Object.keys(body).length !== 2 || typeof body.transaction_id !== 'string' || typeof body.one_time_code !== 'string') {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const record = await wiring.consent.consumeCode(body.one_time_code, wiring.now());
    // Consumed either way, so a mismatched transaction id cannot be retried with the
    // right one.
    if (!record || record.transaction_id !== body.transaction_id) {
      return context.json({ error: 'code_already_used' }, 400);
    }
    const connection = await wiring.connections.find(record.connection_id);
    const transaction = await deps.readTransaction?.(body.transaction_id);
    const required = new Set(transaction?.required_scopes ?? []);
    if (!connection || connection.status !== 'ACTIVE' || !isSubset(required, new Set(connection.granted_scopes))) {
      return context.json({ error: 'scope_not_in_connection' }, 409);
    }
    return context.json({
      status: 'READY', connection_id: connection.connection_id,
      granted_scopes: normalizeScopes(connection.granted_scopes),
    }, 200);
  });

  app.post('/bindings', callerAuthz(['provisioner'], authz), async (context) => {
    const body = await context.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    const keys = ['agent_id', 'connector_id', 'connection_id', 'human_subject', 'scopes', 'expires_at'];
    if (!body || Object.keys(body).length !== keys.length || keys.some((key) => !(key in body))) {
      return context.json({ error: 'invalid_request' }, 400);
    }
    const connection = await wiring.connections.find(String(body.connection_id));
    if (!connection) return context.json({ error: 'scope_not_in_connection' }, 400);
    const scopes = (body.scopes as string[]) ?? [];
    // Same subset function as the token path: one rule, one implementation.
    if (!isSubset(new Set(scopes), new Set(connection.granted_scopes))) {
      return context.json({ error: 'scope_not_in_connection' }, 400);
    }
    if (connection.human_subject !== body.human_subject) {
      return context.json({ error: 'human_subject_mismatch' }, 400);
    }
    const limit = wiring.now() + Math.min(86_400, deps.config.agentMaxLifetimeSeconds) * 1000;
    if (Date.parse(String(body.expires_at)) > limit) {
      return context.json({ error: 'expires_at_too_far' }, 400);
    }
    try {
      const binding = await wiring.bindings.create({
        agent_id: String(body.agent_id), connector_id: String(body.connector_id),
        connection_id: String(body.connection_id), human_subject: String(body.human_subject),
        scopes, expires_at: String(body.expires_at), now: wiring.now(),
      });
      // The response says what was made and until when — not what it may do.
      return context.json({ binding_id: binding.binding_id, expires_at: binding.expires_at }, 201);
    } catch (error) {
      if (error instanceof BridgeError) return context.json({ error: error.code }, error.status as 400);
      throw error;
    }
  });

  /**
   * The eighth internal route (00b §4). Cleanup asks for the upstream connection to be
   * given up when the reason is abnormal — a quarantine or a disabled identity.
   *
   * The refresh token is sent to the SaaS's own revocation endpoint and the connection
   * is marked REVOKED whatever the far side answers: once the platform has decided to
   * stop using a credential, keeping the row ACTIVE because a remote host was briefly
   * unreachable would leave the next request believing it may still be used.
   */
  app.post('/connections/:connection_id/revoke-upstream', callerAuthz(['lifecycle'], authz), async (context) => {
    const connectionId = context.req.param('connection_id');
    const connection = await wiring.connections.find(connectionId);
    // Already gone is success: cleanup retries, and a missing connection is the goal.
    if (!connection) return context.body(null, 204);

    const connector = await wiring.connectors.getConnector(connection.connector_id).catch(() => undefined);
    if (connector) {
      const body = new URLSearchParams({
        token: await cipher.decryptRefreshToken(connection.encrypted_refresh_token),
        token_type_hint: 'refresh_token',
        client_id: connector.client_id,
        client_secret: await deps.readSecret(connector.secret_name),
      });
      await wiring.bridgeFetch(connector.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      }, allowedHostsFor({ connector, jwksUrl: deps.config.jwksUrl })).catch(() => undefined);
    }

    await wiring.connections.setStatus(connectionId, 'REVOKED');
    return context.body(null, 204);
  });

  app.post('/bindings/:agent_id/disable', callerAuthz(['lifecycle'], authz), async (context) => {
    await wiring.bindings.disableAll(context.req.param('agent_id'));
    // 204 even for nothing: cleanup retries, and "already disabled" is success.
    return context.body(null, 204);
  });

  app.delete('/bindings/:agent_id', callerAuthz(['lifecycle'], authz), async (context) => {
    await wiring.bindings.deleteAll(context.req.param('agent_id'));
    return context.body(null, 204);
  });

  return app;
}

/**
 * The callback face: three routes, the only part of the Bridge a browser reaches.
 *
 * It issues no token and holds no route that could. Everything it sends back to the
 * Automation App goes through the redirect guard first.
 */
export function createCallbackApp(deps: BridgeDeps): Hono {
  const wiring = wire(deps);
  const app = new Hono();
  const cipher = createConnectorCipher({ kms: deps.kms, keyName: deps.config.connectorEncryptionKey });

  app.get('/livez', (context) => context.json({ status: 'ok', app: 'google-bridge-callback' }));

  app.get('/:connector_id/oauth/start', async (context) => {
    const connectorId = context.req.param('connector_id');
    const transactionId = context.req.query('transaction_id') ?? '';
    const transaction = await deps.readTransaction?.(transactionId);
    // Checked before anything is generated: an unknown transaction must not produce a
    // state row or a redirect an attacker could follow.
    if (!transaction || transaction.status !== 'WAITING_EXTERNAL_CONSENT') {
      return context.json({ error: 'invalid_transaction' }, 400);
    }
    const connector = await wiring.connectors.getConnector(connectorId);
    const state = newState();
    const pkce = await createPkce();
    await wiring.consent.putState(state, {
      transaction_id: transactionId, connector_id: connectorId,
      human_subject: transaction.human_subject, required_scopes: transaction.required_scopes,
      code_verifier: pkce.verifier,
    }, wiring.now());

    // The host comes from the connector definition; nothing in the request contributes
    // to it, so there is no open redirect to find.
    const target = new URL(connector.authorization_endpoint);
    for (const [key, value] of Object.entries({
      client_id: connector.client_id,
      redirect_uri: `${deps.config.bridgeCallbackBaseUrl}/${connectorId}/oauth/callback`,
      response_type: 'code',
      scope: transaction.required_scopes.join(' '),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    })) target.searchParams.set(key, value);

    assertNoTokenInRedirect(target.toString());
    emitCallbackLog(wiring.logger, wiring.logContext, { connector_id: connectorId, transaction_id: transactionId, result: 'redirected' });
    return context.redirect(target.toString(), 302);
  });

  app.get('/:connector_id/oauth/callback', async (context) => {
    const connectorId = context.req.param('connector_id');
    const state = context.req.query('state') ?? '';
    const code = context.req.query('code') ?? '';
    const consumed = await wiring.consent.consumeState(state);
    if (!consumed) return context.json({ error: 'invalid_state' }, 400);

    const fail = (reason: string): Response => {
      const location = `${deps.config.automationAppBaseUrl}/consent/failed?transaction_id=${encodeURIComponent(consumed.transaction_id)}&reason=${reason}`;
      assertNoTokenInRedirect(location);
      emitCallbackLog(wiring.logger, wiring.logContext, { connector_id: connectorId, transaction_id: consumed.transaction_id, result: reason });
      return context.redirect(location, 302);
    };

    const connector = await wiring.connectors.getConnector(connectorId);
    const allowed = allowedHostsFor({ connector, jwksUrl: deps.config.jwksUrl });
    let payload: Record<string, unknown>;
    try {
      const response = await wiring.bridgeFetch(connector.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code,
          redirect_uri: `${deps.config.bridgeCallbackBaseUrl}/${connectorId}/oauth/callback`,
          client_id: connector.client_id,
          client_secret: await deps.readSecret(connector.secret_name),
          code_verifier: consumed.code_verifier,
        }).toString(),
      }, allowed);
      if (!response.ok) return fail('code_exchange_failed');
      payload = await response.json() as Record<string, unknown>;
    } catch {
      return fail('code_exchange_failed');
    }

    const externalSubject = await resolveSubject();
    if (!externalSubject) return fail('subject_unresolved');
    if (typeof payload.refresh_token !== 'string') return fail('code_exchange_failed');

    const connection = await wiring.connections.upsert({
      connectorId,
      humanSubject: consumed.human_subject,
      externalSubject,
      refreshToken: await cipher.encryptRefreshToken(payload.refresh_token),
      grantedScopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : consumed.required_scopes,
      maxAgeSeconds: connector.connection_max_age_seconds,
      now: wiring.now(),
    });

    const oneTimeCode = newState();
    await wiring.consent.putCode(oneTimeCode, {
      transaction_id: consumed.transaction_id, connection_id: connection.connection_id,
    }, wiring.now());

    const location = `${deps.config.automationAppBaseUrl}/consent/complete?transaction_id=${encodeURIComponent(consumed.transaction_id)}&code=${encodeURIComponent(oneTimeCode)}`;
    assertNoTokenInRedirect(location);
    emitCallbackLog(wiring.logger, wiring.logContext, { connector_id: connectorId, transaction_id: consumed.transaction_id, result: 'completed' });
    return context.redirect(location, 302);

    /**
     * The first Access Token from this exchange stays a local. It is never stored and
     * never returned: the agent gets its own, minted per request, from `/token`.
     */
    async function resolveSubject(): Promise<string | undefined> {
      if (typeof payload.id_token === 'string') {
        try {
          const claims = JSON.parse(Buffer.from(payload.id_token.split('.')[1]!, 'base64url').toString('utf8')) as { sub?: string };
          if (claims.sub) return claims.sub;
        } catch { /* fall through to userinfo */ }
      }
      if (typeof payload.access_token !== 'string') return undefined;
      try {
        const response = await wiring.bridgeFetch(connector.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${payload.access_token}` },
        }, allowed);
        if (!response.ok) return undefined;
        const info = await response.json() as Record<string, unknown>;
        const value = info[connector.subject_claim];
        return typeof value === 'string' ? value : undefined;
      } catch { return undefined; }
    }
  });

  return app;
}

/**
 * DEC-APP-07's entry point, and the only place the two faces are chosen between.
 *
 * An unset or unknown `BRIDGE_FACE` throws rather than falling back. A default would
 * mean a misconfigured deployment starts anyway and serves the wrong half — the
 * browser-facing service answering `/token`, or the token service reachable from a
 * browser — and neither failure announces itself.
 */
function createApp(deps: BridgeDeps): Hono {
  if (deps.config.face === 'internal') return createInternalApp(deps);
  if (deps.config.face === 'callback') return createCallbackApp(deps);
  throw new Error('BRIDGE_FACE must be internal or callback');
}

export default createApp;
export { parseScope };
