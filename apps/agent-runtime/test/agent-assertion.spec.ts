import { describe, expect, it } from 'vitest';
import { decodeJwsUnverified } from '@xaa/crypto';
import { AGENT_URN_PREFIX, JWT_TYP, toAgentUrn } from '@xaa/contracts';
import { ACTOR_TOKEN_LIFETIME_SECONDS, buildActorToken } from '../src/tokens/agent-assertion.js';
import { CLIENT_ASSERTION_LIFETIME_SECONDS, buildClientAssertion } from '../src/tokens/client-assertion.js';
import { AGENT_ID, AGENT_OP, testContext } from './helpers.js';

/**
 * T-RUN-09. Two JWTs are signed with the same Agent Client Credential and must never
 * be mistaken for one another: the actor token says who is acting inside an exchange,
 * the client assertion authenticates the caller to the Agent OP. They are built by
 * two functions, each writing its own `typ` as a literal, so a change to one cannot
 * silently re-address the other.
 */
describe('the agent assertion', () => {
  it('header and payload match the fixed shape', async () => {
    const context = await testContext();
    const now = Date.parse('2026-03-01T12:00:00.000Z');

    const actor = decodeJwsUnverified(await buildActorToken(context, now));
    expect(actor.header.typ).toBe(JWT_TYP.ACTOR_TOKEN);
    expect(actor.header.alg).toBe('ES256');
    expect(actor.header.kid).toBe(`${AGENT_ID}-client-key`);
    // DEV-15: addressed to the token endpoint from AGENT_OP_BASE_URL, not from an issuer.
    expect(actor.payload.aud).toBe(`${AGENT_OP}/xaa/token`);
    expect(actor.payload.iss).toBe(AGENT_ID);
    expect(actor.payload.sub).toBe(AGENT_ID);
    expect(Number(actor.payload.exp) - Number(actor.payload.iat)).toBe(300);
    expect(ACTOR_TOKEN_LIFETIME_SECONDS).toBe(300);

    // The client assertion is a different token: different typ, audience and lifetime.
    const client = decodeJwsUnverified(await buildClientAssertion(context, '/xaa/subject-token', now));
    expect(client.header.typ).toBe(JWT_TYP.CLIENT_ASSERTION);
    expect(client.header.kid).toBe(`${AGENT_ID}-client-key`);
    expect(client.payload.aud).toBe(`${AGENT_OP}/xaa/subject-token`);
    expect(Number(client.payload.exp) - Number(client.payload.iat)).toBe(CLIENT_ASSERTION_LIFETIME_SECONDS);
    expect(CLIENT_ASSERTION_LIFETIME_SECONDS).toBe(120);
  });

  it('jti is 128bit and differs per call', async () => {
    const context = await testContext();
    const now = Date.parse('2026-03-01T12:00:00.000Z');
    const jtiOf = (token: { payload: Record<string, unknown> }): string => String(token.payload.jti);

    const first = jtiOf(decodeJwsUnverified(await buildActorToken(context, now)));
    const second = jtiOf(decodeJwsUnverified(await buildActorToken(context, now)));
    expect(Buffer.from(first, 'base64url')).toHaveLength(16);
    expect(first).not.toBe(second);

    // The client assertion numbers its own, so a replay of one is not a replay of both.
    const clientJti = jtiOf(decodeJwsUnverified(await buildClientAssertion(context, '/xaa/token', now)));
    expect(Buffer.from(clientJti, 'base64url')).toHaveLength(16);
    expect(new Set([first, second, clientJti]).size).toBe(3);
  });

  it('toAgentUrn is idempotent', () => {
    const once = toAgentUrn(AGENT_ID);
    expect(once).toBe(`${AGENT_URN_PREFIX}${AGENT_ID}`);
    expect(toAgentUrn(once)).toBe(once);
    expect(toAgentUrn(toAgentUrn(once))).toBe(once);
  });

  it('signs both with the execution key and never with a KMS client', async () => {
    const context = await testContext();
    let signed = 0;
    const spied = { ...context, agentClientKey: {
      ...context.agentClientKey,
      signCompactJws: async (header: Record<string, unknown>, payload: Record<string, unknown>) => {
        signed += 1;
        return context.agentClientKey.signCompactJws(header as never, payload);
      },
    } };
    await buildActorToken(spied as typeof context);
    await buildClientAssertion(spied as typeof context, '/xaa/token');
    expect(signed).toBe(2);
  });
});
