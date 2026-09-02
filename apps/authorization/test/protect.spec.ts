import { describe, expect, it } from 'vitest';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws } from '@xaa/crypto';
import { PROTOCOL_VALIDATION_EVENT, VALIDATION_NAME_TO_CODE } from '@xaa/contracts';
import { createAuthzHarness, testConfig } from './helpers.js';

const RAW_DPOP_PROOF = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJqdGkiOiJwcm9vZiJ9.signature';

/**
 * An Access Token signed by a key the platform's JWKS does not publish, and addressed
 * to the wrong audience. Two of the eight checks are broken at once; only the first is
 * reported.
 */
async function forgedToken(): Promise<string> {
  const pair = await generateEs256KeyPair();
  const now = Math.floor(Date.now() / 1000);
  return signCompactJws({
    header: { alg: 'ES256', typ: 'at+jwt', kid: 'not-a-published-kid' },
    payload: {
      iss: testConfig.issuer, sub: 'user-123', aud: 'lifecycle-manager',
      scope: 'workdef:submit', exp: now + 300, iat: now, jti: 'at-jti', cnf: { jkt: 'thumb' },
    },
    signer: createLocalEs256Signer({ privateKey: pair.privateKey, kid: 'not-a-published-kid' }),
  });
}

async function callWithBrokenToken() {
  const harness = await createAuthzHarness();
  const token = await forgedToken();
  const response = await harness.fetch('/api/work-requests', {
    method: 'POST',
    headers: {
      Authorization: `DPoP ${token}`,
      DPoP: RAW_DPOP_PROOF,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ human_subject: 'someone-else', purpose: 'p' }),
  });
  const validations = harness.logs
    .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> })
    .filter((line) => line.event === PROTOCOL_VALIDATION_EVENT);
  return { response, validations, token, raw: harness.logs.join('\n') };
}

/**
 * T-SEC-12. What a refused Control Plane request leaves behind.
 *
 * The guard's job is to refuse; this file is about the record of the refusal, which is
 * Security Detection's entire input. Two properties matter and neither is obvious from
 * the middleware: exactly one event per refused request, and nothing in it that a
 * reader could replay.
 */
describe('the Control Plane protection middleware', () => {
  it('emits only the first failing validation', async () => {
    const { response, validations } = await callWithBrokenToken();

    expect(response.status).toBe(401);
    // The signature is checked before the audience, so the audience never gets a verdict:
    // an event per broken check would grow with the attacker's effort, not the platform's.
    expect(validations).toHaveLength(1);
    expect(validations[0]!.fields.validation).toBe(VALIDATION_NAME_TO_CODE['invalid signature']);
    expect(validations[0]!.fields.outcome).toBe('fail');
    expect(validations.map((line) => line.fields.validation)).not.toContain('audience_mismatch');
  });

  it('event has no raw token', async () => {
    const { validations, token, raw } = await callWithBrokenToken();

    const payload = JSON.stringify(validations[0]);
    expect(payload).not.toContain(token);
    expect(payload).not.toContain(RAW_DPOP_PROOF);
    // Nor under any other name: the whole line is checked, not the two known keys.
    expect(payload).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(Object.keys(validations[0]!.fields)).not.toContain('access_token');
    expect(Object.keys(validations[0]!.fields)).not.toContain('dpop_proof');
    // And nothing else the request produced carried them either.
    expect(raw).not.toContain(token);
  });

  it('names the route template rather than the url it was called with', async () => {
    const { validations } = await callWithBrokenToken();
    expect(validations[0]!.fields.path).toBe('authorization:/api');
    expect(String(validations[0]!.fields.path)).not.toContain('?');
  });
});
