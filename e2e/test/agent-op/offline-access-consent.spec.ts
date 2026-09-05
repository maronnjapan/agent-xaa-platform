import { describe, expect, it } from 'vitest';
import { createFirestoreDocumentStore, createFirestoreDouble } from '@xaa/gcp';
import {
  AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, humanIdpAsFetch, idpPublicJwk, startHumanIdp,
} from '../../harness/human-idp.js';
import { authorize, followAuthorizeUrl, tokenRequest } from '../../harness/oauth-flow.js';
import {
  PROVISIONER_SA, reissueSubjectToken, seedIdpConnection, startAgentOp, type AgentOpHarness,
} from '../../harness/agent-op.js';

/**
 * REQ-05-047 / REQ-05-051. The offline_access consent against the Human IdP itself,
 * rather than against a `humanIdpFetch` that always answers with a refresh token.
 *
 * The stubbed version of this trip (offline-access.spec.ts) proves what the Agent OP
 * stores once a token comes back. What it cannot see is whether the Human IdP hands
 * one over at all, and twice now it has not: first because the Basic credentials were
 * not form-url-encoded, then because DPOP_REQUIRED demanded a proof of a back-channel
 * client that has no key to make one with. Both ended on the same opaque
 * "認可を完了できませんでした" page, so this suite drives the browser through the real
 * /authorize, /login and /consent and redeems the code at the real /token.
 *
 * The Human IdP runs as Terraform deploys it, DPOP_REQUIRED and all — RULE-06 covers
 * three DPoP routes and Agent OP -> Human IdP is not one of them (docs 05 §2).
 */
const CALLBACK_BASE = new URL(AGENT_OP_CALLBACK_URI).origin;
const CONSENT_EXPIRY = () => new Date(Date.now() + 3_600_000).toISOString();

/**
 * The two faces as Terraform sets them (infra/envs/demo/services.tf): both know where
 * the callback service lives, and each is public at its own URL. The redirect_uri the
 * Agent OP builds and the one it replays at /token have to agree, and they only do
 * because the callback service is the one that names itself.
 */
const tokenFaceConfig = { agentOpCallbackUrl: CALLBACK_BASE } as const;
const callbackFaceConfig = { agentOpCallbackUrl: CALLBACK_BASE, publicBaseUrl: CALLBACK_BASE, mode: 'callback' } as const;

async function requestConsentUrl(op: AgentOpHarness, expiresAt: string): Promise<string> {
  const response = await op.fetch('/internal/idp-connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVISIONER_SA}` },
    body: JSON.stringify({
      agentId: op.agentId, humanSubject: 'testuser',
      idpConnectionId: `idpconn-${op.agentId}`, expiresAt, transactionId: 'txn-1',
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { status: string; consentUrl: string };
  expect(body.status).toBe('CONSENT_REQUIRED');
  return body.consentUrl;
}

describe('offline_access consent, end to end against the Human IdP', () => {
  it('redeems the code and sends the browser on to the Automation App', async () => {
    const shared = createFirestoreDouble();
    const idp = await startHumanIdp();
    const idpJwk = await idpPublicJwk();
    const expiresAt = CONSENT_EXPIRY();

    const tokenFace = await startAgentOp({
      shared, idpPublicJwk: idpJwk, provisionerServiceAccount: PROVISIONER_SA,
      expiresAt, config: { ...tokenFaceConfig },
    });
    const consentUrl = await requestConsentUrl(tokenFace, expiresAt);

    // The person clicks through the Human IdP's own pages.
    const consented = await followAuthorizeUrl({
      fetch: idp.fetch, url: consentUrl, issuer: HUMAN_IDP_ISSUER, redirectUri: AGENT_OP_CALLBACK_URI,
    });
    expect(consented.error).toBeUndefined();
    expect(consented.code).toBeDefined();
    expect(consented.location.startsWith(AGENT_OP_CALLBACK_URI)).toBe(true);

    // ... and lands on the public callback service, which redeems the code itself.
    const callbackFace = await startAgentOp({
      shared, idpPublicJwk: idpJwk, agentId: tokenFace.agentId, expiresAt,
      config: { ...callbackFaceConfig }, humanIdpFetch: humanIdpAsFetch(idp),
    });
    const returned = new URL(consented.location);
    const back = await callbackFace.fetch(`${returned.pathname}${returned.search}`);
    expect(back.status).toBe(302);

    const store = createFirestoreDocumentStore(shared, 'agent-op');
    const connection = await store.get<{ status: string }>('idp_connections', `idpconn-${tokenFace.agentId}`);
    expect(connection!.status).toBe('ACTIVE');

    const onward = new URL(back.headers.get('location')!);
    expect(onward.pathname).toBe('/provisioning/resume');
    expect(onward.searchParams.get('transaction_id')).toBe('txn-1');
  });

  it('spends the refresh token from that grant for a subject_token', async () => {
    // The second back-channel call the Agent OP makes, and the second one the blanket
    // DPoP flag used to reject: without it an agent gets one ID Token at provisioning
    // time and never another, so it stops reaching resources partway through its run.
    const idp = await startHumanIdp();
    const op = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), humanIdpFetch: humanIdpAsFetch(idp) });

    const consented = await authorize({
      fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
      scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
    });
    const granted = await tokenRequest({
      fetch: idp.fetch, clientId: 'agent-platform', clientSecret: 'agent-platform-secret',
      issuer: HUMAN_IDP_ISSUER,
      form: {
        grant_type: 'authorization_code', code: consented.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
        code_verifier: consented.pkce.verifier, client_id: 'agent-platform',
      },
    });
    expect(granted.status).toBe(200);
    const { refresh_token: refreshToken } = await granted.json() as { refresh_token: string };
    await seedIdpConnection(op, {}, refreshToken);

    const reissued = await reissueSubjectToken(op);
    expect(reissued.status).toBe(200);
    const body = await reissued.json() as { subject_token: string; subject_token_type: string };
    expect(body.subject_token_type).toBe('urn:ietf:params:oauth:token-type:id_token');
    // An ID Token from the Human IdP, addressed to the client that holds the grant.
    const claims = JSON.parse(Buffer.from(body.subject_token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims.iss).toBe(HUMAN_IDP_ISSUER);
    expect(claims.aud).toBe('agent-platform');
    expect(claims.sub).toBe('testuser');
  });
});
