import { Hono } from 'hono';
import { PLATFORM_CLIENT_ID } from '@xaa/contracts';
import type { AgentOpDeps } from '../deps.js';
import { createAgentOpStore } from '../store/index.js';
import { emitIdpConnectionLog } from '../log/idp-connection-log.js';
import { humanIdpClientAuthHeader } from '../idp-connection/human-idp-auth.js';

export interface ServiceIdentityVerifier {
  /** Resolves to the caller's service account email, or null when untrusted. */
  verify(authorization: string | undefined): Promise<string | null>;
}

/**
 * REQ-01-028. Cleanup asks Agent OP to hand the refresh token back to Human IdP.
 *
 * The connection is marked REVOKED even when the upstream call fails: giving up on
 * the local state because the remote is unavailable would leave a usable credential
 * behind. The answer is a 502 in that case, so Cleanup retries rather than reporting
 * a revocation that did not happen, and the ciphertext is kept for that retry — it is
 * dropped only once Human IdP has actually accepted the token back.
 *
 * The plaintext token stays inside this function — no return value, no exception
 * message and no log line carries it (RULE-22 / RULE-51).
 */
export function createInternalRevokeRoute(deps: AgentOpDeps, verifier: ServiceIdentityVerifier, allowedCaller: string): Hono {
  const store = createAgentOpStore(deps.documents, deps.config, () => deps.signer.kid);
  const httpFetch = deps.humanIdpFetch ?? globalThis.fetch;

  const app = new Hono();
  app.post('/', async (context) => {
    const caller = await verifier.verify(context.req.header('authorization'));
    if (caller !== allowedCaller) return context.json({ error: 'invalid_client' }, 403);

    const body = await context.req.json<{ agent_id?: unknown }>().catch(() => ({} as { agent_id?: unknown }));
    if (typeof body.agent_id !== 'string') return context.json({ error: 'invalid_request' }, 400);

    const connection = await store.idpConnections.findByAgent(body.agent_id);
    if (!connection) return context.json({ revoked: false }, 404);

    let revokeResult: 'ok' | 'failed' = 'ok';
    try {
      const refreshToken = await deps.envelope.decrypt(connection.encrypted_refresh_token, connection.agent_id);
      const response = await httpFetch(deps.config.humanIdpRevokeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // agent-platform is confidential: client_id alone is answered 401.
          authorization: humanIdpClientAuthHeader(deps.config),
        },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: PLATFORM_CLIENT_ID }).toString(),
      });
      if (!response.ok) revokeResult = 'failed';
    } catch {
      revokeResult = 'failed';
    }

    if (revokeResult === 'ok') {
      // Accepted upstream: the ciphertext has nothing left to buy, so it goes.
      await store.idpConnections.revokeAndForgetToken(connection.idp_connection_id);
    } else {
      // Refused or unreachable: stop spending it here, but keep what a retry needs.
      await store.idpConnections.update(connection.idp_connection_id, { status: 'REVOKED' });
    }
    emitIdpConnectionLog({
      idp_connection_id: connection.idp_connection_id,
      rotation_result: 'not_rotated',
      reuse_detected: false,
      subject_token_reissue: 'n/a',
      revoke_result: revokeResult,
    }, deps.writeConnectionLog);
    if (revokeResult === 'failed') {
      return context.json({ error: 'revoke_failed', revoke_result: revokeResult, connection_status: 'REVOKED' }, 502);
    }
    return context.json({ revoked: true, revoke_result: revokeResult });
  });
  return app;
}
