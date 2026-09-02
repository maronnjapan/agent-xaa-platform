import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectLogFields } from '@xaa/logging';
import { createTestApp, testEnv } from './helpers.js';

/**
 * T-SEC-05: one `app.fetch` call, one captured stdout line, and the shared
 * `expectLogFields` helper checks it against `IDENTITY_EVENT_FIELDS['idp.authenticate']`
 * rather than a hand-copied field list.
 */
describe('Human IdP structured logging', () => {
  it('expectLogFields recognizes idp.authenticate on a rejected /authorize request', async () => {
    const lines: string[] = [];
    const app = await createTestApp({}, (line) => lines.push(line));

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: 'automation-app',
      redirect_uri: testEnv.automationAppRedirectUri,
      // automation-app is never granted agent:destroy, so this fails before login.
      scope: 'openid agent:destroy',
      state: 'state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    await app.fetch(`/authorize?${query.toString()}`, { redirect: 'manual' });

    expect(lines).toHaveLength(1);
    const fields = expectLogFields(lines[0]!, 'idp.authenticate');
    expect(fields.auth_result).toBe('failure');
    expect(fields.dpop_result).toBe('not_applicable');
  });
});
