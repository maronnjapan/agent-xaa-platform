import { Hono } from 'hono';
import { PLATFORM_CLIENT_ID } from '@xaa/contracts';
import type { AgentOpDeps } from '../deps.js';
import { createAgentOpStore } from '../store/index.js';
import { verifyAgentState } from '../idjag/verify-agent-state.js';
import { RotationHistory } from '../idp-connection/reuse-detection.js';
import { emitIdpConnectionLog } from '../log/idp-connection-log.js';
import { emitProtocolViolationEvent } from '../log/protocol-violation-event.js';
import type { AgentRegistration } from '../store/types.js';

const ROTATION_HISTORY_TTL_SECONDS = 86_400;

/**
 * REQ-05-051 / DEC-ID-19. No ID Token is minted here. The stored refresh token is
 * decrypted and spent against Human IdP's /token, and only the `id_token` from that
 * response is handed back; `access_token` and `refresh_token` never appear in the
 * reply body.
 */
export function createSubjectTokenRoute(deps: AgentOpDeps): Hono {
  const store = createAgentOpStore(deps.documents, deps.config, () => deps.signer.kid);
  const history = new RotationHistory(deps.documents, ROTATION_HISTORY_TTL_SECONDS);
  const httpFetch = deps.humanIdpFetch ?? globalThis.fetch;

  const app = new Hono();
  app.post('/', async (context) => {
    const registration = context.get('agentRegistration' as never) as AgentRegistration;
    const now = new Date(deps.now?.() ?? Date.now());
    let rotationResult: 'rotated' | 'failed' | 'not_rotated' = 'not_rotated';
    let reuseDetected = false;
    let reissue: 'ok' | 'failed' | 'n/a' = 'n/a';
    let connectionId = registration.idp_connection_id;

    try {
      verifyAgentState(registration, now);
      const connection = await store.idpConnections.find(registration.idp_connection_id)
        ?? await store.idpConnections.findByAgent(registration.agent_id);
      if (!connection || connection.status !== 'ACTIVE' || Date.parse(connection.expires_at) <= now.getTime()) {
        return context.json({ error: 'invalid_grant', error_description: 'The IdP connection is not usable' }, 400);
      }
      connectionId = connection.idp_connection_id;

      const refreshToken = await deps.envelope.decrypt(connection.encrypted_refresh_token, connection.agent_id);
      const response = await httpFetch(deps.config.humanIdpTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // No `scope`: narrowing here would silently drop offline_access.
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: PLATFORM_CLIENT_ID, refresh_token: refreshToken }).toString(),
      });

      if (!response.ok) {
        reissue = 'failed';
        // Only a token we know we rotated away counts as reuse; an ordinary
        // expiry must not be reported as a security event.
        if (await history.wasRotated(connection.idp_connection_id, refreshToken)) {
          reuseDetected = true;
          await emitProtocolViolationEvent(deps.publisher, {
            violation_code: 'refresh_token_reuse', agent_id: registration.agent_id,
            human_subject: registration.human_subject, ...(deps.now ? { now: deps.now } : {}),
          });
          await store.idpConnections.update(connection.idp_connection_id, { status: 'REVOKED' });
          await revokeUpstream(deps, refreshToken).catch(() => undefined);
        }
        return context.json({ error: 'invalid_grant', error_description: 'The IdP connection is not usable' }, 400);
      }

      const body = await response.json() as { id_token?: string; refresh_token?: string; expires_in?: number };
      if (!body.id_token) {
        reissue = 'failed';
        return context.json({ error: 'invalid_grant', error_description: 'The IdP connection is not usable' }, 400);
      }
      reissue = 'ok';

      // Rotation only when a new token actually came back; otherwise the existing
      // ciphertext stands rather than being blindly overwritten.
      if (body.refresh_token) {
        await history.remember(connection.idp_connection_id, refreshToken);
        await store.idpConnections.update(connection.idp_connection_id, {
          encrypted_refresh_token: await deps.envelope.encrypt(body.refresh_token, connection.agent_id),
        });
        rotationResult = 'rotated';
      }

      return context.json({
        subject_token: body.id_token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        expires_in: body.expires_in ?? 3600,
      });
    } catch {
      reissue = reissue === 'n/a' ? 'failed' : reissue;
      return context.json({ error: 'invalid_grant', error_description: 'The IdP connection is not usable' }, 400);
    } finally {
      emitIdpConnectionLog({
        idp_connection_id: connectionId,
        refresh_rotation_result: rotationResult,
        refresh_reuse_detected: reuseDetected,
        subject_token_refetch_result: reissue,
        revoke_result: reuseDetected ? 'ok' : 'n/a',
      }, deps.writeConnectionLog);
    }
  });
  return app;
}

async function revokeUpstream(deps: AgentOpDeps, refreshToken: string): Promise<void> {
  const httpFetch = deps.humanIdpFetch ?? globalThis.fetch;
  await httpFetch(deps.config.humanIdpRevokeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: PLATFORM_CLIENT_ID }).toString(),
  });
}
