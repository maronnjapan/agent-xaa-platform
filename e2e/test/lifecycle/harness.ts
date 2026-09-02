import { randomUUID } from 'node:crypto';
import { createDpopProof, createLocalEs256Signer, signCompactJws } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE, JWT_TYP } from '@xaa/contracts';
import { AGENT_OP_BASE, type AgentOpHarness } from '../../harness/agent-op.js';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, startHumanIdp, type HumanIdpHarness } from '../../harness/human-idp.js';

const CLIENT = { clientId: 'agent-platform', clientSecret: 'agent-platform-secret' };

export interface HumanConnection {
  /** The browser session cookie, so a second consent can be silent. */
  cookie: string | undefined;
  idToken: string;
  refreshToken: string;
}

/**
 * One trip through the Human IdP, as the Agent OP's callback makes it.
 *
 * The lifecycle tests need real tokens rather than fixtures, because what they assert
 * is that a revoke reaches the Human IdP's own token store — a hand-made string would
 * only prove that a hand-made string was rejected.
 */
export async function connectHuman(idp: HumanIdpHarness, cookie?: string): Promise<HumanConnection> {
  const result = await authorize({
    fetch: idp.fetch, clientId: CLIENT.clientId, redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER,
    ...(cookie ? { cookie, prompt: 'none' } : { prompt: 'consent' }),
  });
  if (!result.code) throw new Error(`authorize did not return a code: ${result.error ?? 'unknown'}`);
  const response = await tokenRequest({
    fetch: idp.fetch, ...CLIENT, issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: CLIENT.clientId,
    },
  });
  const tokens = await response.json() as { id_token: string; refresh_token: string };
  return { cookie: result.cookie, idToken: tokens.id_token, refreshToken: tokens.refresh_token };
}

/** A subject token for the token exchange, with its own Human IdP. */
export async function humanSubjectToken(): Promise<string> {
  return (await connectHuman(await startHumanIdp())).idToken;
}

export { CLIENT as PLATFORM_CLIENT };


/**
 * `/xaa/subject-token`, called the way the Agent Runtime calls it.
 *
 * The route is behind the same client-assertion and DPoP middlewares as the token
 * exchange, so a test that wants to see it refuse after a quarantine has to get past
 * both first — otherwise the refusal it observes is the wrong one.
 */
export async function requestSubjectToken(harness: AgentOpHarness): Promise<Response> {
  const path = '/xaa/subject-token';
  const issuedAt = Math.floor(harness.now() / 1000);
  const clientAssertion = await signCompactJws({
    header: { alg: 'ES256', typ: JWT_TYP.CLIENT_ASSERTION, kid: harness.agentId },
    payload: {
      iss: harness.agentId, sub: harness.agentId, aud: `${AGENT_OP_BASE}${path}`,
      iat: issuedAt, exp: issuedAt + 120, jti: randomUUID(),
    },
    signer: createLocalEs256Signer({ privateKey: harness.agentKeyPair.privateKey, kid: harness.agentId }),
  });
  return harness.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      DPoP: await createDpopProof({
        method: 'POST', url: `${AGENT_OP_BASE}${path}`, keyPair: harness.dpopKeyPair, now: harness.now,
      }),
    },
    body: new URLSearchParams({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: clientAssertion,
    }).toString(),
  });
}
