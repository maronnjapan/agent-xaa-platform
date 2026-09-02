import { describe, expect, it } from 'vitest';
import { expectLogFields, expectNoRawToken } from '@xaa/logging';
import { createTestAs } from './helpers.js';

/**
 * A JWS whose header names a kid and a typ and whose signature is meaningless.
 *
 * REQ-05-034 joins what a Resource AS accepted against what the Agent OP recorded
 * issuing, and the interesting row is the one the AS refused: a token signed with an
 * Agent OP kid that has no issuance record. So the two join keys are read from the
 * assertion before it is verified, and are written whether verification succeeds or not.
 */
function forgedIdJag(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part(header)}.${part(payload)}.not-a-signature`;
}

async function redeem(assertion: string) {
  const as = await createTestAs();
  const response = await as.fetch('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
      client_id: 'agent-platform',
    }).toString(),
  });
  const line = as.logs.at(-1)!;
  return { response, entry: JSON.parse(line) as { event: string; fields: Record<string, unknown> }, line };
}

describe('the Resource AS redemption log', () => {
  it('logs received kid and typ on verification failure', async () => {
    const { response, entry, line } = await redeem(forgedIdJag(
      { alg: 'ES256', kid: 'idjag-abcdefghijkl-1', typ: 'oauth-id-jag+jwt' },
      { iss: 'https://shared-agent-op.test', sub: 'testuser', jti: 'jti-forged' },
    ));

    expect(response.status).toBe(400);
    expect(entry.event).toBe('resource_as.redeem');
    // Every field of the table in docs 09 §2 is present, under the table's own names (T-SEC-05).
    expectLogFields(line, 'resource_as.redeem');
    // The signature never verified, and the join keys are recorded all the same.
    expect(entry.fields.received_kid).toBe('idjag-abcdefghijkl-1');
    expect(entry.fields.received_typ).toBe('oauth-id-jag+jwt');
    expect(entry.fields.idjag_jti).toBe('jti-forged');
    expect(entry.fields.token_issue_result).toBe(false);
  });

  it('records a wrong typ rather than normalising it away', async () => {
    const { entry } = await redeem(forgedIdJag(
      { alg: 'ES256', kid: 'idjag-abcdefghijkl-1', typ: 'at+jwt' },
      { iss: 'https://shared-agent-op.test', sub: 'testuser', jti: 'jti-wrong-typ' },
    ));
    // `signing_key_misuse` reads exactly this: the ledger has the jti, but what the AS
    // received was not an ID-JAG.
    expect(entry.fields.received_typ).toBe('at+jwt');
  });

  it('writes null join keys rather than dropping them when nothing can be decoded', async () => {
    const { entry } = await redeem('not-a-jws');
    expect(Object.keys(entry.fields)).toEqual(expect.arrayContaining(['received_kid', 'received_typ']));
    expect(entry.fields.received_kid).toBeNull();
    expect(entry.fields.received_typ).toBeNull();
  });

  it('carries no raw assertion on the line', async () => {
    const { line, entry } = await redeem(forgedIdJag(
      { alg: 'ES256', kid: 'idjag-abcdefghijkl-1', typ: 'oauth-id-jag+jwt' },
      { iss: 'https://shared-agent-op.test', sub: 'testuser', jti: 'jti-1' },
    ));
    expect(() => expectNoRawToken(entry.fields, 'resource_as.redeem')).not.toThrow();
    expect(line).not.toMatch(/"eyJ[A-Za-z0-9_-]{4,}\./);
  });
});
