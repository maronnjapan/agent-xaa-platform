import { describe, expect, it } from 'vitest';
import { generateEs256KeyPair, createDpopProof } from '@xaa/crypto';
import { STEP_NAMES } from '../src/idjag/pipeline.js';
import {
  AGENT_OP_BASE, actorToken, clientAssertion, createFixture, DOCS_AS_ISSUER, exchange,
  type Fixture,
} from './helpers.js';

interface Broken {
  step: string;
  code: string;
  break(fixture: Fixture): Promise<Parameters<typeof exchange>[1]>;
}

/**
 * One way to break each step that can fail, and the error code the step answers with.
 *
 * The later steps — `build_claims` through `build_response` — have no input that can
 * make them fail on their own: by then every value has been verified, so a failure there
 * would be a bug rather than a refusal, and there is nothing to provoke.
 */
const BROKEN: Broken[] = [
  {
    step: 'authorize_client', code: 'invalid_client',
    async break(fixture) { return { assertion: await clientAssertion(fixture, { keyPair: await generateEs256KeyPair() }) }; },
  },
  {
    step: 'parse_params', code: 'invalid_request',
    async break() { return { form: { actor_token: '' } }; },
  },
  {
    step: 'resolve_subject', code: 'invalid_grant',
    async break() { return { form: { subject_token: 'not-a-token' } }; },
  },
  {
    step: 'resolve_actor', code: 'invalid_grant',
    async break(fixture) { return { form: { actor_token: await actorToken(fixture, { agentId: 'agent-abcdefghijklmnopqrstuvwxyz' }) } }; },
  },
  {
    step: 'validate_audience', code: 'invalid_scope',
    async break() { return { form: { audience: 'https://elsewhere.test' } }; },
  },
  {
    step: 'validate_scope', code: 'invalid_scope',
    async break() { return { form: { scope: 'finance.tx.write' } }; },
  },
  {
    step: 'validate_resource', code: 'invalid_scope',
    async break() { return { form: { resource: 'https://elsewhere.test' } }; },
  },
];

async function attempt(broken: Broken) {
  const fixture = await createFixture();
  const response = await exchange(fixture, await broken.break(fixture));
  const lines = fixture.exchangeLogs.map((line) => JSON.parse(line) as { fields: Record<string, unknown> });
  return { fixture, response, lines };
}

/**
 * T-SEC-13 / REQ-05-075. What a refused `/xaa/token` leaves behind.
 *
 * Each step is broken on its own, and the record is checked for two things: that the
 * refusal was reported once rather than once per check the request would also have
 * failed, and that the report names the step's own code. Anything else and the detection
 * side is reading a count that grows with how badly a request was formed.
 */
describe('the ten step validation record', () => {
  it('emits one event per failing step', async () => {
    expect(STEP_NAMES).toHaveLength(13);
    for (const broken of BROKEN) {
      const { response, lines } = await attempt(broken);
      expect(response.status, broken.step).toBeGreaterThanOrEqual(400);

      if (broken.step === 'authorize_client') {
        // Client authentication is refused before the pipeline runs, so there is no
        // exchange record to write: the refusal belongs to the middleware.
        expect(lines, broken.step).toHaveLength(0);
        expect((await response.json() as { error: string }).error).toBe(broken.code);
        continue;
      }
      expect(lines, broken.step).toHaveLength(1);
      expect(lines[0]!.fields.error_code, broken.step).toBe(broken.code);
    }
  });

  it('event carries no raw assertion', async () => {
    const fixture = await createFixture();
    const proof = await createDpopProof({
      method: 'POST', url: `${AGENT_OP_BASE}/xaa/token`, keyPair: fixture.dpopKeyPair, now: fixture.now,
    });
    const assertion = await clientAssertion(fixture, { path: '/xaa/token' });
    await exchange(fixture, { assertion, proof, form: { audience: 'https://elsewhere.test' } });

    const written = [...fixture.exchangeLogs, JSON.stringify(fixture.events)].join('\n');
    expect(written).not.toContain(assertion);
    expect(written).not.toContain(proof);
    // Whatever the field is called: a compact JWS anywhere on the line is the failure.
    expect(written).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    for (const forbidden of ['"subject_token"', '"actor_token"', '"client_assertion"']) {
      expect(written).not.toContain(forbidden);
    }
  });

  it('reports the audience refusal against the registered audience, not the requested one', async () => {
    const { lines } = await attempt(BROKEN.find((entry) => entry.step === 'validate_audience')!);
    expect(lines[0]!.fields.requested_audience).toBe('https://elsewhere.test');
    expect(lines[0]!.fields.requested_audience).not.toBe(DOCS_AS_ISSUER);
  });
});
