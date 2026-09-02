import { beforeAll, describe, expect, it } from 'vitest';
import { generateEs256KeyPair, jwkThumbprint, toPublicJwk } from '@xaa/crypto';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { FINANCE_AS_ISSUER, FINANCE_API_RESOURCE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { mintIdJag, redeemForAccessToken, startResource, type ResourceHarness } from '../../harness/resource.js';

/** REQ-09-011: the twelve fields every redemption must carry, allowed or denied. */
const REDEMPTION_FIELDS = [
  'idjag_iss', 'idjag_sub', 'idjag_act_sub', 'idjag_client_id', 'idjag_jti', 'idjag_kid', 'idjag_typ',
  'audience', 'resource', 'scope', 'cnf_jkt_match', 'token_issued',
];

interface LogLine { event: string; fields: Record<string, unknown> }

function redemptions(harness: ResourceHarness): LogLine[] {
  return harness.asLogs.map((line) => JSON.parse(line) as LogLine).filter((entry) => entry.event === 'resource_as.redeem');
}

let idpJwk: JsonWebKey;
let subjectToken: string;

beforeAll(async () => {
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
  subjectToken = (await response.json() as { id_token: string }).id_token;
  idpJwk = await idpPublicJwk();
});

describe('the finance Authorization Server logs every redemption', () => {
  it('records the twelve fields on an accepted redemption', async () => {
    const agentOp = await startAgentOp({
      idpPublicJwk: idpJwk, isolationLevel: 'full_isolation',
      allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
      scopes: ['finance.tx.read', 'finance.tx.write'],
    });
    const docs = await startResource({ kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, scope: 'finance.tx.read finance.tx.write' })).json() as { access_token: string }).access_token;
    const redeemed = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair });
    expect(redeemed.status).toBe(200);

    const entry = redemptions(docs).at(-1)!;
    for (const field of REDEMPTION_FIELDS) expect(Object.keys(entry.fields)).toContain(field);
    expect(entry.fields.idjag_typ).toBe('oauth-id-jag+jwt');
    expect(entry.fields.idjag_kid).toBe('op-shared-1');
    expect(entry.fields.idjag_act_sub).toBe(`urn:xaa:agent:${agentOp.agentId}`);
    expect(entry.fields.cnf_jkt_match).toBe(true);
    expect(entry.fields.token_issued).toBe(true);
    expect(entry.fields.authorization_decision).toBe('allow');
  });

  it('records the same twelve fields when the confirmation binding fails', async () => {
    const agentOp = await startAgentOp({
      idpPublicJwk: idpJwk, isolationLevel: 'full_isolation',
      allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
      scopes: ['finance.tx.read', 'finance.tx.write'],
    });
    const docs = await startResource({ kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, scope: 'finance.tx.read finance.tx.write' })).json() as { access_token: string }).access_token;
    const refused = await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair, proofKeyPair: await generateEs256KeyPair() });
    expect(refused.status).toBe(400);

    const entry = redemptions(docs).at(-1)!;
    for (const field of REDEMPTION_FIELDS) expect(Object.keys(entry.fields)).toContain(field);
    expect(entry.fields.cnf_jkt_match).toBe(false);
    expect(entry.fields.token_issued).toBe(false);
    expect(entry.fields.authorization_decision).toBe('deny:invalid_grant');
    expect(entry.fields.validation_name).toBe('dpop_key_binding_mismatch');
  });

  it('still names jti, kid and typ when the signature never verified', async () => {
    const agentOp = await startAgentOp({
      idpPublicJwk: idpJwk, isolationLevel: 'full_isolation',
      allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
      scopes: ['finance.tx.read', 'finance.tx.write'],
    });
    const docs = await startResource({ kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    // Signed by a key the AS has never published: verification cannot succeed, and
    // the join keys against the Agent OP's issuance ledger still have to be logged.
    const stranger = await generateEs256KeyPair();
    const idJag = await mintIdJag({
      keyPair: stranger, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, isolationLevel: 'full_isolation',
      jkt: await jwkThumbprint(await toPublicJwk(agentOp.dpopKeyPair.publicKey)),
    });
    expect((await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).status).toBe(400);

    const entry = redemptions(docs).at(-1)!;
    expect(entry.fields.idjag_jti).not.toBeNull();
    expect(entry.fields.idjag_kid).not.toBeNull();
    expect(entry.fields.idjag_typ).not.toBeNull();
  });

  it('keeps the assertion and the issued token out of the log', async () => {
    const agentOp = await startAgentOp({
      idpPublicJwk: idpJwk, isolationLevel: 'full_isolation',
      allowedAudiences: [FINANCE_AS_ISSUER], resources: [FINANCE_API_RESOURCE],
      scopes: ['finance.tx.read', 'finance.tx.write'],
    });
    const docs = await startResource({ kind: 'finance', agentOpPublicJwk: agentOp.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER });
    const idJag = (await (await requestIdJag(agentOp, { subjectToken, audience: FINANCE_AS_ISSUER, resource: FINANCE_API_RESOURCE, scope: 'finance.tx.read finance.tx.write' })).json() as { access_token: string }).access_token;
    const accessToken = (await (await redeemForAccessToken(docs, { idJag, keyPair: agentOp.dpopKeyPair })).json() as { access_token: string }).access_token;

    const serialised = JSON.stringify(redemptions(docs));
    expect(serialised).not.toContain(idJag);
    expect(serialised).not.toContain(accessToken);
  });
});
