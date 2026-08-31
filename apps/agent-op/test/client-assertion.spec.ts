import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair } from '@xaa/crypto';
import { CLIENT_ASSERTION_TYPE } from '@xaa/contracts';
import { clientAssertion, createFixture, exchange, newAgentId } from './helpers.js';

async function bodyOf(response: Response) {
  return response.json() as Promise<{ error: string; error_description: string }>;
}

describe('Agent Client Credential authentication', () => {
  it('rejects a missing client_assertion', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { client_assertion: '' } });
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).error).toBe('invalid_client');
  });

  it('rejects a wrong client_assertion_type', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { form: { client_assertion_type: 'urn:example:other' } });
    expect(response.status).toBe(401);
  });

  it('rejects an assertion signed with another agent key', async () => {
    const fixture = await createFixture();
    const other = await generateEs256KeyPair();
    const response = await exchange(fixture, { assertion: await clientAssertion(fixture, { keyPair: other }) });
    expect(response.status).toBe(401);
  });

  it('rejects the wrong typ', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { assertion: await clientAssertion(fixture, { typ: 'JWT' }) });
    expect(response.status).toBe(401);
  });

  it('rejects a jwk header before signature verification', async () => {
    const fixture = await createFixture();
    const attacker = await generateEs256KeyPair();
    const response = await exchange(fixture, {
      assertion: await clientAssertion(fixture, { keyPair: attacker, header: { jwk: attacker.publicJwk } }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects a replayed jti', async () => {
    const fixture = await createFixture();
    const assertion = await clientAssertion(fixture, { jti: 'fixed-jti' });
    expect((await exchange(fixture, { assertion })).status).toBe(200);
    expect((await exchange(fixture, { assertion })).status).toBe(401);
  });

  it('rejects an assertion minted for the other endpoint', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { assertion: await clientAssertion(fixture, { path: '/xaa/subject-token' }) });
    expect(response.status).toBe(401);
  });

  it('rejects an assertion whose lifetime exceeds 300 seconds', async () => {
    const fixture = await createFixture();
    const response = await exchange(fixture, { assertion: await clientAssertion(fixture, { lifetime: 400 }) });
    expect(response.status).toBe(401);
  });

  it('rejects an unknown agent', async () => {
    const fixture = await createFixture();
    const unknown = await generateEs256KeyPair();
    const response = await exchange(fixture, { assertion: await clientAssertion(fixture, { agentId: newAgentId(), keyPair: unknown }) });
    expect(response.status).toBe(401);
  });

  it('error_description is constant across all failure modes', async () => {
    const fixture = await createFixture();
    const other = await generateEs256KeyPair();
    const descriptions = new Set<string>();
    for (const options of [
      { form: { client_assertion: '' } },
      { form: { client_assertion_type: 'urn:example:other' } },
      { assertion: await clientAssertion(fixture, { keyPair: other }) },
      { assertion: await clientAssertion(fixture, { typ: 'JWT' }) },
      { assertion: await clientAssertion(fixture, { lifetime: 400 }) },
    ]) {
      descriptions.add((await bodyOf(await exchange(fixture, options))).error_description);
    }
    expect([...descriptions]).toEqual(['Client authentication failed']);
  });

  it('uses the IANA client assertion type constant', () => {
    expect(CLIENT_ASSERTION_TYPE).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  });
});
