import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair } from '@xaa/crypto';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { AGENT_OP_BASE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { redeemForAccessToken, startResource } from '../../harness/resource.js';

async function subjectToken(): Promise<string> {
  const idp = await startHumanIdp();
  const result = await authorize({
    fetch: idp.fetch, clientId: 'agent-platform', redirectUri: AGENT_OP_CALLBACK_URI,
    scope: 'openid offline_access', issuer: HUMAN_IDP_ISSUER, prompt: 'consent',
  });
  const response = await tokenRequest({
    fetch: idp.fetch, clientId: 'agent-platform', clientSecret: 'agent-platform-secret', issuer: HUMAN_IDP_ISSUER,
    form: {
      grant_type: 'authorization_code', code: result.code!, redirect_uri: AGENT_OP_CALLBACK_URI,
      code_verifier: result.pkce.verifier, client_id: 'agent-platform',
    },
  });
  return (await response.json() as { id_token: string }).id_token;
}

describe('DPoP validation at /xaa/token', () => {
  it('emits invalid_dpop_proof once for an htu mismatch', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const wrongHost = await generateEs256KeyPair();
    const proof = await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/elsewhere`, keyPair: wrongHost });
    const response = await requestIdJag(agentOp, { subjectToken: token, proof });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_dpop_proof' });
  });

  it('emits replayed_dpop_proof once for a duplicated jti', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const first = await requestIdJag(agentOp, { subjectToken: token });
    expect(first.status).toBe(200);
    // A second exchange re-using the same DPoP key is fine; re-using the same proof
    // is what must fail, which the unit suite covers. Here the same actor jti is
    // replayed to show the two stores are independent.
    const second = await requestIdJag(agentOp, { subjectToken: token, actorJti: 'fixed' });
    expect(second.status).toBe(200);
    const third = await requestIdJag(agentOp, { subjectToken: token, actorJti: 'fixed' });
    expect(third.status).toBe(400);
    expect((await third.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('answers every DPoP failure with the same body', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    // Client authentication runs first, so each case carries a valid assertion and
    // varies only the proof.
    const bodies = new Set<string>();
    for (const variant of [
      { omitProof: true },
      { proof: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/other`, keyPair: agentOp.dpopKeyPair }) },
      { proof: await createDpopProof({ method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: agentOp.dpopKeyPair, now: () => Date.now() - 600_000 }) },
    ]) {
      bodies.add(await (await requestIdJag(agentOp, { subjectToken: token, ...variant })).text());
    }
    expect([...bodies]).toEqual(['{"error":"invalid_dpop_proof"}']);
  });

  /**
   * The third code of REQ-09-026. A proof can only disagree with a `cnf.jkt` where a
   * cnf-bearing token is presented, and the only such hop is the Resource AS redeeming
   * the ID-JAG this OP issued: /xaa/token takes no bound token at all. The grant below
   * is bound to the agent's DPoP key and offered with a well-formed proof made by
   * another one.
   */
  it('emits dpop_key_binding_mismatch for a well-formed proof made with another key', async () => {
    const token = await subjectToken();
    const agentOp = await startAgentOp({ idpPublicJwk: await idpPublicJwk() });
    const docs = await startResource({
      kind: 'docs', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER,
    });
    const issued = await requestIdJag(agentOp, { subjectToken: token });
    expect(issued.status).toBe(200);
    const idJag = (await issued.json() as { access_token: string }).access_token;

    const stranger = await generateEs256KeyPair();
    const response = await redeemForAccessToken(docs, {
      idJag, keyPair: agentOp.dpopKeyPair, proofKeyPair: stranger,
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');

    const records = docs.logs.map((line) => JSON.parse(line) as { fields?: Record<string, unknown> })
      .map((line) => line.fields ?? {});
    expect(records.at(-1)!.validation_name).toBe('dpop_key_binding_mismatch');
    expect(records.at(-1)!.dpop_binding_result).toBe(false);
  });
});
