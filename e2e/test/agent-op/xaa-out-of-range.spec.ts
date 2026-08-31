import { beforeAll, describe, expect, it } from 'vitest';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AGENT_OP_CALLBACK_URI, HUMAN_IDP_ISSUER, idpPublicJwk, startHumanIdp } from '../../harness/human-idp.js';
import { DOCS_AS_ISSUER, DOCS_API_RESOURCE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';

let token: string;
let idpJwk: JsonWebKey;

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
  token = (await response.json() as { id_token: string }).id_token;
  idpJwk = await idpPublicJwk();
});

describe('requests outside the static XAA configuration', () => {
  it('an unregistered audience returns invalid_scope with one violation event', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
    const response = await requestIdJag(agentOp, { subjectToken: token, audience: 'https://not-registered.test' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
    expect(agentOp.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('an unregistered resource returns invalid_scope with one violation event', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
    const response = await requestIdJag(agentOp, { subjectToken: token, resource: 'https://not-registered.test' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
    expect(agentOp.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('a scope outside the configuration returns invalid_scope with one violation event', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk, scopes: ['docs.read'] });
    const response = await requestIdJag(agentOp, { subjectToken: token, scope: 'docs.write' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_scope');
    expect(agentOp.events.filter((event) => event.detail.violation_code === 'xaa_config_out_of_range')).toHaveLength(1);
  });

  it('never names the allow list in the error description', async () => {
    const agentOp = await startAgentOp({ idpPublicJwk: idpJwk });
    const response = await requestIdJag(agentOp, { subjectToken: token, audience: 'https://not-registered.test' });
    const body = await response.json() as { error_description: string };
    expect(body.error_description).not.toContain(DOCS_AS_ISSUER);
    expect(body.error_description).not.toContain(DOCS_API_RESOURCE);
  });
});
