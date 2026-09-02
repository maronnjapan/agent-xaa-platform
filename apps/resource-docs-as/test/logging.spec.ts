import { describe, expect, it } from 'vitest';
import { createLocalEs256Signer, generateEs256KeyPair, signCompactJws } from '@xaa/crypto';
import { PLATFORM_CLIENT_ID } from '@xaa/contracts';
import { expectLogFields } from '@xaa/logging';
import { createTestAs } from './helpers.js';

const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/**
 * T-SEC-05 completion condition: `received_kid` and `received_typ` are read from the
 * assertion header with `decodeJwsUnverified` before signature verification runs, so
 * they must still appear in the log line even when that verification fails — the
 * whole point of the two fields is to catch an ID-JAG a trusted OP never signed
 * (`signing_key_misuse`, docs 09 §5.1).
 */
describe('Resource AS structured logging', () => {
  it('logs received kid and typ on verification failure', async () => {
    const as = await createTestAs();
    const untrustedSigner = createLocalEs256Signer({
      privateKey: (await generateEs256KeyPair()).privateKey, kid: 'not-a-real-op-key',
    });
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signCompactJws({
      header: { alg: 'ES256', kid: untrustedSigner.kid, typ: 'oauth-id-jag+jwt' } as never,
      payload: {
        iss: 'https://shared-agent-op.test', sub: 'testuser', aud: 'https://resource-docs-as.test',
        resource: 'https://resource-docs-api.test', client_id: PLATFORM_CLIENT_ID, scope: 'docs.read',
        act: { sub: 'urn:agent:agent-abcdefghijklmnopqrstuvwxyz' },
        iat: now, exp: now + 60, jti: 'jti-untrusted-1',
      },
      signer: untrustedSigner,
    });

    const response = await as.fetch('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: JWT_BEARER_GRANT_TYPE, client_id: PLATFORM_CLIENT_ID, assertion,
      }).toString(),
    });
    expect(response.status).toBe(400);

    expect(as.logs).toHaveLength(1);
    const fields = expectLogFields(as.logs[0]!, 'resource_as.redeem');
    expect(fields.received_kid).toBe('not-a-real-op-key');
    expect(fields.received_typ).toBe('oauth-id-jag+jwt');
    expect(fields.token_issue_result).toBe(false);
    expect(fields.authz_decision).not.toBe('allow');
  });
});
