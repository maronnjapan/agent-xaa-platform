import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair, jwkThumbprint } from '@xaa/crypto';
import { JWT_BEARER_GRANT_TYPE, assertNoTokenInRedirect } from '@xaa/contracts';
import { createFirestoreDouble } from '@xaa/gcp';
import createStubApi from '@xaa/stub-saas-api/app';
import {
  completeConsent, createBridgeHarness, seedConnector, transactionReader,
  INTERNAL_BASE, SA, STUB_CONNECTOR,
} from '@xaa/google-bridge/src/testing/harness';
import { AGENT_OP_BASE, requestIdJag, startAgentOp } from '../../harness/agent-op.js';
import { HUMAN_IDP_ISSUER, idpPublicJwk } from '../../harness/human-idp.js';
import { humanIdToken } from '../runtime/native-xaa-path.spec.js';

const AGENT_ID_PREFIX = 'agent-';
const STUB_API_BASE = 'https://stub-saas-api.test';

/**
 * The bridged path, end to end: consent, ID-JAG, refresh grant, SaaS call.
 *
 * The point of the exercise is the last hop. What the Bridge hands back is an ordinary
 * Bearer token from the external SaaS — no `cnf`, no DPoP — because the SaaS has never
 * heard of this platform's binding scheme (REQ-05-023, DEC-ID-13). The internal hops are
 * DPoP-bound throughout; the boundary is exactly where the Bridge sits.
 */
describe('the bridged path', () => {
  it('walks consent, exchange and the SaaS call', async () => {
    const shared = createFirestoreDouble();
    const dpopKey = await generateEs256KeyPair();
    const jkt = await jwkThumbprint(dpopKey.publicJwk);

    // (1) The person logs in and (2) an agent is registered against the Bridge audience.
    const subjectToken = await humanIdToken();
    const agentOp = await startAgentOp({
      idpPublicJwk: await idpPublicJwk(),
      allowedAudiences: [INTERNAL_BASE],
      resources: [STUB_API_BASE],
      scopes: ['calendar.read'],
    });
    expect(agentOp.agentId.startsWith(AGENT_ID_PREFIX)).toBe(true);

    const bridge = createBridgeHarness({
      shared,
      jwks: { keys: [agentOp.opPublicJwk as Record<string, unknown>] },
      readTransaction: transactionReader(),
    });
    await seedConnector(bridge);

    // (3)(4) Consent at the stub SaaS and back, through the callback face.
    const { code } = await completeConsent(bridge);
    expect(code).toBeTruthy();

    // (5) The Provisioner verifies the connection and creates the binding.
    const provisioner = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
    const verified = await provisioner.internal('/connections/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
      body: JSON.stringify({ transaction_id: 'tx-1', one_time_code: code }),
    });
    expect(verified.status).toBe(200);
    const connection = await verified.json() as { connection_id: string; granted_scopes: string[] };
    expect(connection.granted_scopes).toEqual(['calendar.read']);

    const bound = await provisioner.internal('/bindings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
      body: JSON.stringify({
        agent_id: agentOp.agentId, connector_id: STUB_CONNECTOR.connector_id,
        connection_id: connection.connection_id, human_subject: 'testuser',
        scopes: ['calendar.read'], expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    expect(bound.status).toBe(201);

    // (6) The agent gets an ID-JAG from its own OP — not minted by this test.
    const issued = await requestIdJag(agentOp, {
      subjectToken, audience: INTERNAL_BASE, resource: STUB_API_BASE, scope: 'calendar.read',
      dpopKeyPair: dpopKey,
    });
    expect(issued.status).toBe(200);
    const idJag = (await issued.json() as { access_token: string }).access_token;

    // (7) The Bridge exchanges it, with a DPoP proof over the same key.
    // Same stub SaaS as the consent step: it is the one that knows this refresh token.
    const runtime = createBridgeHarness({
      shared, stubOp: bridge.stubOp,
      jwks: { keys: [agentOp.opPublicJwk as Record<string, unknown>] },
      readTransaction: transactionReader(),
    });
    const exchanged = await runtime.internal('/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Bearer caller',
        DPoP: await createDpopProof({ method: 'POST', url: `${INTERNAL_BASE}/token`, keyPair: dpopKey }),
      },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT_TYPE, assertion: idJag }).toString(),
    });
    expect(exchanged.status).toBe(200);
    const token = await exchanged.json() as Record<string, unknown>;
    expect(Object.keys(token).sort()).toEqual(['access_token', 'expires_in', 'scope', 'token_type']);
    expect(token.token_type).toBe('Bearer');
    // No proof-of-possession on the way out: the SaaS never agreed to one.
    expect(token).not.toHaveProperty('cnf');
    expect(JSON.stringify(token)).not.toContain(jkt);

    // (8)(9) The agent calls the SaaS itself, with a plain Bearer and no DPoP header.
    const api = createStubApi();
    const events = await api.fetch(new Request(`${STUB_API_BASE}/calendar/events`, {
      headers: { Authorization: `Bearer ${token.access_token as string}` },
    }));
    expect(events.status).toBe(200);
    expect((await events.json() as { events: unknown[] }).events).toHaveLength(3);
  });

  it('asks for no consent the second time the same person provisions', async () => {
    const shared = createFirestoreDouble();
    const bridge = createBridgeHarness({ shared, readTransaction: transactionReader() });
    await seedConnector(bridge);
    await completeConsent(bridge);
    const authorizeCalls = bridge.outbound.filter((url) => url.includes('/authorize')).length;

    const second = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
    const checked = await second.internal('/connections/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
      body: JSON.stringify({
        connector_id: STUB_CONNECTOR.connector_id, human_subject: 'testuser', required_scopes: ['calendar.read'],
      }),
    });
    expect(await checked.json()).toMatchObject({ status: 'READY' });
    // No second visit to the SaaS, and still one connection.
    expect(second.outbound.filter((url) => url.includes('/authorize'))).toHaveLength(0);
    expect(authorizeCalls).toBe(0);
    expect(await second.documents.listAll('bridge_connections')).toHaveLength(1);
  });

  it('never puts a token in a redirect', async () => {
    const bridge = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(bridge);
    const started = await bridge.callback(`/${STUB_CONNECTOR.connector_id}/oauth/start?transaction_id=tx-1`, { redirect: 'manual' });
    const authorizeUrl = started.headers.get('location')!;
    expect(() => assertNoTokenInRedirect(authorizeUrl)).not.toThrow();

    const authorized = await bridge.stubOp.fetch(new Request(authorizeUrl, { redirect: 'manual' }));
    const back = new URL(authorized.headers.get('location')!);
    const finished = await bridge.callback(`${back.pathname}${back.search}`, { redirect: 'manual' });
    const complete = finished.headers.get('location')!;
    expect(() => assertNoTokenInRedirect(complete)).not.toThrow();
    expect([...new URL(complete).searchParams.keys()].sort()).toEqual(['code', 'transaction_id']);
  });

  it('refuses a state offered twice', async () => {
    const bridge = createBridgeHarness({ readTransaction: transactionReader() });
    await seedConnector(bridge);
    const started = await bridge.callback(`/${STUB_CONNECTOR.connector_id}/oauth/start?transaction_id=tx-1`, { redirect: 'manual' });
    const authorized = await bridge.stubOp.fetch(new Request(started.headers.get('location')!, { redirect: 'manual' }));
    const back = new URL(authorized.headers.get('location')!);

    expect((await bridge.callback(`${back.pathname}${back.search}`, { redirect: 'manual' })).status).toBe(302);
    const replayed = await bridge.callback(`${back.pathname}${back.search}`, { redirect: 'manual' });
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toEqual({ error: 'invalid_state' });
  });

  it('refuses a one-time code offered twice', async () => {
    const shared = createFirestoreDouble();
    const bridge = createBridgeHarness({ shared, readTransaction: transactionReader() });
    await seedConnector(bridge);
    const { code } = await completeConsent(bridge);
    const provisioner = createBridgeHarness({ shared, caller: SA.provisioner, readTransaction: transactionReader() });
    const verify = () => provisioner.internal('/connections/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer caller' },
      body: JSON.stringify({ transaction_id: 'tx-1', one_time_code: code }),
    });
    expect((await verify()).status).toBe(200);
    const replayed = await verify();
    expect(replayed.status).toBe(400);
    expect(await replayed.json()).toEqual({ error: 'code_already_used' });
  });

  it('refuses to start consent for a transaction that is not waiting', async () => {
    const bridge = createBridgeHarness({ readTransaction: transactionReader({ status: 'COMPLETED' }) });
    await seedConnector(bridge);
    const response = await bridge.callback(`/${STUB_CONNECTOR.connector_id}/oauth/start?transaction_id=tx-1`, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_transaction' });
    // Nothing left behind for a later replay to use.
    expect(await bridge.documents.listAll('bridge_consent_states')).toHaveLength(0);
  });
});

describe('the Agent OP still refuses what the Bridge would', () => {
  it('will not issue an ID-JAG for an audience the agent was never given', async () => {
    const subjectToken = await humanIdToken();
    const agentOp = await startAgentOp({
      idpPublicJwk: await idpPublicJwk(), allowedAudiences: [INTERNAL_BASE], resources: [STUB_API_BASE],
      scopes: ['calendar.read'],
    });
    const response = await requestIdJag(agentOp, {
      subjectToken, audience: 'https://elsewhere.test', resource: STUB_API_BASE, scope: 'calendar.read',
    });
    expect(response.status).toBe(400);
    expect(HUMAN_IDP_ISSUER).toBeTruthy();
    expect(AGENT_OP_BASE).toBeTruthy();
  });
});
