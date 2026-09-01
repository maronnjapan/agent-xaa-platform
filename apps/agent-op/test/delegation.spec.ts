import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair, jwkThumbprint } from '@xaa/crypto';
import { createFixture, exchange, newAgentId, subjectToken } from './helpers.js';

describe('RULE-49 delegation check', () => {
  it('draft 9.7: rejects subject_token(user-A) with actor of an agent delegated by user-B', async () => {
    const fixture = await createFixture({ registration: { human_subject: 'user-B' } });
    const response = await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: 'user-A' }) } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_grant', error_description: 'The delegation relationship could not be verified',
    });
  });

  it('emits exactly one delegation_mismatch activity event', async () => {
    const fixture = await createFixture({ registration: { human_subject: 'user-B' } });
    await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: 'user-A' }) } });
    const violations = fixture.events.filter((event) => event.detail.violation_code === 'delegation_mismatch');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.phase).toBe('security');
    expect(violations[0]!.outcome).toBe('blocked');
  });

  it('records delegation_check=true on match', async () => {
    const fixture = await createFixture();
    await exchange(fixture);
    expect((JSON.parse(fixture.exchangeLogs[0]!) as { fields: { delegation_check: boolean } }).fields.delegation_check).toBe(true);
  });

  it('records delegation_check=false on mismatch', async () => {
    const fixture = await createFixture({ registration: { human_subject: 'user-B' } });
    await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: 'user-A' }) } });
    expect((JSON.parse(fixture.exchangeLogs[0]!) as { fields: { delegation_check: boolean } }).fields.delegation_check).toBe(false);
  });

  it('rejects act.sub equal to sub with invalid_request', async () => {
    // A human whose subject is the agent id itself: namespaces must stay disjoint.
    const agentId = newAgentId();
    const fixture = await createFixture({ registration: { agent_id: agentId, human_subject: agentId } });
    const response = await exchange(fixture, { form: { subject_token: await subjectToken(fixture, { sub: agentId }) } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects an actor_token signed with another agent key with invalid_grant', async () => {
    const fixture = await createFixture();
    const otherKey = await generateEs256KeyPair();
    const response = await exchange(fixture, { form: { actor_token: await (await import('./helpers.js')).actorToken(fixture, { keyPair: otherKey }) } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects a cross-substituted actor: client_assertion of agent A, actor of agent B', async () => {
    const fixture = await createFixture();
    const otherAgent = newAgentId();
    const otherKey = await generateEs256KeyPair();
    void await jwkThumbprint(otherKey.publicJwk);
    const { actorToken } = await import('./helpers.js');
    const response = await exchange(fixture, {
      form: { actor_token: await actorToken(fixture, { agentId: otherAgent, keyPair: otherKey }) },
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });
});
