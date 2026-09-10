import { beforeAll, describe, expect, it } from 'vitest';
import { createProvisionerHarness, createTokenIssuer, seedDecision, type ProvisionerHarness, type TokenIssuer } from './helpers.js';

/**
 * Who may ask this service for an agent (docs 05 §1, T-PROV-08).
 *
 * The Provisioner is reachable only from inside the project, but "inside the project"
 * is not an authorisation: Automation App, the Authorization Platform and Lifecycle all
 * live there. What separates them is the Access Token — its `aud`, its `typ` and its
 * `scope` — so each of those is checked here against a token that differs in that one
 * claim and in nothing else.
 *
 * `aud` is compared as a set membership rather than as a string (DEV-12): the Human
 * IdP's core always appends `${issuer}/userinfo`, so a real token for this service has
 * two elements and an equality test would refuse every one of them.
 */
let issuer: TokenIssuer;

beforeAll(async () => { issuer = await createTokenIssuer(); });

async function harness(): Promise<ProvisionerHarness> {
  return createProvisionerHarness({ idpPublicJwk: issuer.publicJwk });
}

async function request(target: ProvisionerHarness, token: string): Promise<Response> {
  const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
  return issuer.provision(target, { decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480 }, { token });
}

describe('the Human Access Token a provisioning request carries', () => {
  it('refuses a token minted for the Authorization Platform', async () => {
    const target = await harness();
    const response = await request(target, await issuer.accessToken({ aud: ['authorization-platform'] }));
    // The shared Control Plane contract answers 401 `invalid_audience` here: a token
    // for another service is not a token this one can read, so it never reaches the
    // point where a permission could be discussed.
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_audience' });
    expect(response.headers.get('WWW-Authenticate')).toBe('DPoP error="invalid_token"');
    expect(target.jobRuns).toHaveLength(0);
    expect(await target.documents.listAll('provisioning_transactions')).toHaveLength(0);
  });

  it('accepts the two-element audience a real token carries, and refuses a lookalike', async () => {
    const accepted = await harness();
    const ok = await request(accepted, await issuer.accessToken());
    expect(ok.status).toBe(201);

    const refused = await harness();
    // `agent-provisioner-x` shares a prefix with this service and is a different one.
    // Element equality is what tells them apart; a prefix or substring test would not.
    const response = await request(refused, await issuer.accessToken({ aud: ['agent-provisioner-x'] }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_audience' });
    expect(refused.jobRuns).toHaveLength(0);
  });

  it('refuses an ID-JAG presented where an Access Token belongs', async () => {
    const target = await harness();
    // DEC-ID-18. Each token type names itself, and a service accepts exactly one. An
    // ID-JAG is a valid signature over valid claims — and not a delegation from a
    // person to Automation App, which is what this endpoint acts on.
    const response = await request(target, await issuer.accessToken({}, { typ: 'oauth-id-jag+jwt' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_token' });
    expect(target.jobRuns).toHaveLength(0);
  });

  it('refuses a token that was never granted agent:provision', async () => {
    const target = await harness();
    const response = await request(target, await issuer.accessToken({ scope: 'openid workdef:submit' }));
    // 403, not 401: the token is readable and the caller is known. What is missing is
    // the permission, and saying so is what makes the failure diagnosable.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient_scope' });
    expect(await target.documents.listAll('provisioning_transactions')).toHaveLength(0);
  });

  it('refuses a request whose proof is missing', async () => {
    const target = await harness();
    const decisionId = await seedDecision(target, { capabilities: ['document.read'] });
    const response = await issuer.provision(
      target, { decision_id: decisionId, task_id: 't', requested_lifetime_minutes: 480 }, { omitProof: true },
    );
    expect(response.status).toBe(401);
    expect(target.jobRuns).toHaveLength(0);
  });
});
