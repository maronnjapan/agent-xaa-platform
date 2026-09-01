import { Hono } from 'hono';
import { PLATFORM_CLIENT_ID } from '@xaa/contracts';
import type { AgentOpDeps } from '../deps.js';
import { buildAuthorizeUrl, newConsentSecrets } from '../idp-connection/authorize-url.js';
import { createAgentOpStore } from '../store/index.js';
import type { ServiceIdentityVerifier } from './internal-revoke-connection.js';

interface CreateConnectionBody {
  agentId: string;
  humanSubject: string;
  idpConnectionId: string;
  expiresAt: string;
  transactionId?: string;
}

/** Provisioner-only setup API; refresh-token material never crosses this boundary. */
export function createInternalIdpConnectionsRoute(
  deps: AgentOpDeps,
  verifier: ServiceIdentityVerifier,
  allowedCaller: string,
): Hono {
  const app = new Hono();
  const store = createAgentOpStore(deps.documents, deps.config, () => deps.signer.kid);

  const authorize = async (authorization: string | undefined): Promise<boolean> =>
    await verifier.verify(authorization) === allowedCaller;

  app.post('/', async (context) => {
    if (!await authorize(context.req.header('authorization'))) return context.json({ error: 'invalid_client' }, 403);
    const body = await context.req.json<CreateConnectionBody>().catch(() => undefined);
    if (!validCreateBody(body)) return context.json({ error: 'invalid_request' }, 400);
    if (deps.config.agentId && deps.config.agentId !== body.agentId) {
      return context.json({ error: 'agent_not_in_namespace' }, 403);
    }
    const existing = await store.idpConnections.find(body.idpConnectionId);
    if (existing?.status === 'ACTIVE' && existing.agent_id === body.agentId) {
      return context.json({ idp_connection_id: body.idpConnectionId, status: 'READY', consentUrl: '' });
    }

    const { state, codeVerifier } = newConsentSecrets();
    const now = deps.now?.() ?? Date.now();
    await deps.documents.set('bridge_consent_states', state, {
      transaction_id: body.transactionId ?? body.idpConnectionId,
      agent_id: body.agentId,
      human_subject: body.humanSubject,
      code_verifier: codeVerifier,
      idp_connection_id: body.idpConnectionId,
      expires_at: body.expiresAt,
      expire_at: deps.documents.expiryFromNow(600, now),
      used: false,
    });
    const consentUrl = buildAuthorizeUrl({
      authorizeUrl: deps.config.humanIdpAuthorizeUrl,
      clientId: PLATFORM_CLIENT_ID,
      redirectUri: `${deps.config.agentOpCallbackUrl}/xaa/callback`,
      state,
      codeVerifier,
    });
    return context.json({ idp_connection_id: body.idpConnectionId, status: 'CONSENT_REQUIRED', consentUrl });
  });

  app.post('/:id/verify', async (context) => {
    if (!await authorize(context.req.header('authorization'))) return context.json({ error: 'invalid_client' }, 403);
    const connection = await store.idpConnections.find(context.req.param('id'));
    return context.json({ status: connection?.status === 'ACTIVE' ? 'READY' : 'CONSENT_REQUIRED' });
  });

  return app;
}

function validCreateBody(value: CreateConnectionBody | undefined): value is CreateConnectionBody {
  return value !== undefined
    && typeof value.agentId === 'string'
    && typeof value.humanSubject === 'string'
    && typeof value.idpConnectionId === 'string'
    && typeof value.expiresAt === 'string'
    && Number.isFinite(Date.parse(value.expiresAt));
}
