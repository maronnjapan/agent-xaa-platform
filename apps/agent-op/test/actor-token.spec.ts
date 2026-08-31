import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair } from '@xaa/crypto';
import { AGENT_URN_PREFIX, TOKEN_TYPE_JWT } from '@xaa/contracts';
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

  it('normalises act.sub to urn:xaa:agent:<agent_id>', async () => {
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

  it('rejects an actor whose agent id is not the authenticated one', async () => {
    const fixture = await createFixture();
    const other = await generateEs256KeyPair();
    const response = await exchange(fixture, { form: { actor_token: await actorToken(fixture, { agentId: newAgentId(), keyPair: other }) } });
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('pins actor_token_type to the JWT token type', () => {
    expect(TOKEN_TYPE_JWT).toBe('urn:ietf:params:oauth:token-type:jwt');
  });
});
