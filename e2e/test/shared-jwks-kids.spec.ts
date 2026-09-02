import { describe, expect, it } from 'vitest';
import { publishPublicKey, type BucketWriter } from '@xaa/agent-op/src/keys/publish-public-key';
import { createSharedJwks, type JwkSet } from '@xaa/agent-op/src/keys/shared-jwks';
import { authorize, tokenRequest } from '../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../harness/human-idp.js';
import { requestIdJag, startAgentOp } from '../harness/agent-op.js';
import { redeemForAccessToken, startResource } from '../harness/resource.js';

/**
 * REQ-05-061 / docs 05 §5. One issuer, one JWK Set: Human IdP's SSO key, the shared
 * OP's key and every Dedicated OP's key sit in the same `jwks.json`, and a Resource AS
 * tells none of them apart. FULL_ISOLATION narrows which registrations and refresh
 * tokens an OP can reach — not what its signature can say.
 */
function bucketDouble() {
  const objects = new Map<string, string>();
  const storage: BucketWriter = {
    bucket: () => ({
      file: (path: string) => ({
        async save(body: string) { objects.set(path, body); },
        async download(): Promise<[Buffer]> { return [Buffer.from(objects.get(path) ?? '', 'utf8')]; },
        async getMetadata(): Promise<[{ generation?: string | number | null }, ...unknown[]]> { return [{ generation: 1 }]; },
      }),
    }),
  };
  return { storage, objects };
}

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

const DEDICATED_KID = 'idjag-mnopqrstuvwx-2';

describe('the shared JWK Set', () => {
  it('jwks.json lists idp / op-shared / idjag kids', async () => {
    const { storage, objects } = bucketDouble();
    const idpJwk = await idpPublicJwk();
    const shared = await startAgentOp({ idpPublicJwk: idpJwk });
    const dedicated = await startAgentOp({ idpPublicJwk: idpJwk, signingKid: DEDICATED_KID });

    // Each service writes only its own keys/<kid>.json (DEC-IAC-13); the aggregate is
    // what the jwks-publish job assembles out of that prefix.
    await publishPublicKey({ storage, bucket: 'xaa-jwks', kid: 'idp-abcd1234', publicJwk: idpJwk });
    await publishPublicKey({ storage, bucket: 'xaa-jwks', kid: 'op-shared-1', publicJwk: shared.opPublicJwk });
    await publishPublicKey({ storage, bucket: 'xaa-jwks', kid: DEDICATED_KID, publicJwk: dedicated.opPublicJwk });
    expect([...objects.keys()].sort()).toEqual([
      `keys/${DEDICATED_KID}.json`, 'keys/idp-abcd1234.json', 'keys/op-shared-1.json',
    ]);

    const aggregate: JwkSet = { keys: [...objects.values()].map((body) => JSON.parse(body) as JsonWebKey & { kid: string }) };
    const jwks = createSharedJwks({ async read() { return aggregate; } });
    const served = await jwks.loadSharedJwks();
    expect(served.keys.map((key) => key.kid).sort()).toEqual([DEDICATED_KID, 'idp-abcd1234', 'op-shared-1']);
    // 00b: the whole prefix set is idp- / op-shared- / idjag-<short>- / docs-as- / fin-as-.
    for (const key of served.keys) expect(key.kid).toMatch(/^(idp-|op-shared-|idjag-[0-9a-z]{12}-)/);

    // And the same set narrowed for subject_token verification (DEC-ID-20): one file,
    // two views, so a Dedicated OP's key can sign a grant but never a subject_token.
    expect((await jwks.subjectTokenJwks()).keys.map((key) => key.kid)).toEqual(['idp-abcd1234']);
  });

  it('ID-JAG signed by a dedicated key verifies at resource-docs-as', async () => {
    const token = await subjectToken();
    const dedicated = await startAgentOp({ idpPublicJwk: await idpPublicJwk(), signingKid: DEDICATED_KID });
    const docs = await startResource({
      kind: 'docs', agentOpPublicJwk: dedicated.opPublicJwk, trustedIdpIssuer: HUMAN_IDP_ISSUER,
    });

    const issued = await requestIdJag(dedicated, { subjectToken: token });
    expect(issued.status).toBe(200);
    const idJag = (await issued.json() as { access_token: string }).access_token;
    const header = JSON.parse(Buffer.from(idJag.split('.')[0]!, 'base64url').toString('utf8')) as { kid: string };
    expect(header.kid).toBe(DEDICATED_KID);

    const redeemed = await redeemForAccessToken(docs, { idJag, keyPair: dedicated.dpopKeyPair });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({ token_type: 'DPoP' });
  });
});
