import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair } from '@xaa/crypto';
import { AGENT_URN_PREFIX, TOKEN_TYPE_JWT } from '@xaa/contracts';
import { createActorTokenResolver } from '../src/idjag/actor-token-resolver.js';
import { ActorTokenReplayStore } from '../src/idjag/actor-token-replay.js';
import { actorToken, createFixture, decodePayload, exchange, newAgentId } from './helpers.js';

describe('actor_token profile', () => {
  it('rejects a request without actor_token with invalid_request', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { actor_token: '', actor_token_type: '' } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects actor_token_type access_token with invalid_request', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { actor_token_type: 'urn:ietf:params:oauth:token-type:access_token' } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects subject_token_type refresh_token with invalid_request', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects an actor_token with a jwk header before the signature check', async () => {
    const fixture = await createFixture();
    const attacker = await generateEs256KeyPair();
    const response = await exchange(fixture, {
      form: { actor_token: await actorToken(fixture, { keyPair: attacker, header: { jwk: attacker.publicJwk } }) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects the wrong actor_token typ', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { actor_token: await actorToken(fixture, { typ: 'JWT' }) } });
    expect(response.status).toBe(400);
  });

  it('normalizes act.sub to urn:xaa:agent:<agent_id>', async () => {
    const fixture = await createFixture();
    const body = await (await exchange(fixture)).json() as { access_token: string };
    expect((decodePayload(body.access_token).act as { sub: string }).sub).toBe(`${AGENT_URN_PREFIX}${fixture.agentId}`);
  });

  it('rejects the same actor_token on second use', async () => {
    const fixture = await createFixture();
    const token = await actorToken(fixture, { jti: 'reused-actor-jti' });
    expect((await exchange(fixture, { form: { actor_token: token } })).status).toBe(200);
    const second = await exchange(fixture, { form: { actor_token: token } });
    expect(second.status).toBe(400);
    expect((await second.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects an expired actor_token', async () => {
    const fixture = await createFixture();
    const stale = await actorToken(fixture, { iat: Math.floor(fixture.now() / 1000) - 600, lifetime: 120 });
    const response = await exchange(fixture, { form: { actor_token: stale } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects an actor_token whose lifetime exceeds 300 seconds', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { actor_token: await actorToken(fixture, { lifetime: 400 }) } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects actor_token signed with another agent key', async () => {
    const fixture = await createFixture();
    const other = await generateEs256KeyPair();
    const response = await exchange(fixture, { form: { actor_token: await actorToken(fixture, { agentId: newAgentId(), keyPair: other }) } });
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('pins actor_token_type to the JWT token type', () => {
    expect(TOKEN_TYPE_JWT).toBe('urn:ietf:params:oauth:token-type:jwt');
  });

  /**
   * The same agent id, a key the registration does not know: the signature check is
   * what fails, and a resolver that returns null makes the library answer
   * invalid_request. Only an actor belonging to another agent is invalid_grant.
   */
  it('rejects an actor_token whose signature does not verify against the registered key', async () => {
    const fixture = await createFixture();
    const otherKey = await generateEs256KeyPair();
    const response = await exchange(fixture, { form: { actor_token: await actorToken(fixture, { keyPair: otherKey }) } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects cross-substituted client_assertion (agent-001 key, actor sub agent-002)', async () => {
    const fixture = await createFixture();
    const otherAgent = newAgentId();
    const otherKey = await generateEs256KeyPair();
    const response = await exchange(fixture, {
      form: { actor_token: await actorToken(fixture, { agentId: otherAgent, keyPair: otherKey }) },
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  /**
   * The route already pins actor_token_type, but the resolver is fail-closed on its
   * own so a future caller cannot reach it past that gate (DEC-ID-10).
   */
  it('rejects non-jwt actor_token_type', async () => {
    const fixture = await createFixture();
    const resolver = createActorTokenResolver({
      authenticatedAgentId: fixture.agentId, registration: fixture.registration,
    });
    const resolved = await resolver({
      actorToken: await actorToken(fixture),
      actorTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      clientId: 'agent-platform', issuer: 'https://human-idp.test', jwks: { keys: [] } as never,
    });
    expect(resolved).toBeNull();
  });
});

describe('actor_token jti store', () => {
  it('evicts jti entries after 360 seconds', () => {
    let clock = 1_000_000;
    const store = new ActorTokenReplayStore(() => clock);
    expect(store.consume('agent-a', 'jti-1')).toBe(true);
    expect(store.consume('agent-a', 'jti-1')).toBe(false);
    expect(store.size).toBe(1);

    // 360 = the 300 second maximum lifetime plus the 60 second leeway.
    clock += 361_000;
    expect(store.consume('agent-a', 'jti-2')).toBe(true);
    expect(store.size).toBe(1);
    expect(store.consume('agent-a', 'jti-1')).toBe(true);
  });

  /**
   * The actor_token store is an in-process Map, so a replay that lands on another
   * Cloud Run instance is not caught here. The client_assertion jti, which uses the
   * Firestore-backed store (00b §1), is what closes that gap for the credential.
   */
  it('known limitation: jti store is per-instance', () => {
    const now = () => 1_000_000;
    const instanceA = new ActorTokenReplayStore(now);
    const instanceB = new ActorTokenReplayStore(now);
    expect(instanceA.consume('agent-a', 'jti-1')).toBe(true);
    expect(instanceA.consume('agent-a', 'jti-1')).toBe(false);
    expect(instanceB.consume('agent-a', 'jti-1')).toBe(true);
  });
});
