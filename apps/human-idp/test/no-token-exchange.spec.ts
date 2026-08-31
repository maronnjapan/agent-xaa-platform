import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basicAuth, createTestApp, formBody } from './helpers.js';

async function tokenRequest(grantType: string) {
  const app = await createTestApp();
  return app.fetch('/token', {
    ...formBody({ grant_type: grantType, subject_token: 'x', subject_token_type: 'urn:ietf:params:oauth:token-type:id_token', audience: 'https://docs-as.test' }),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuth('agent-platform', 'agent-platform-secret'),
    },
  });
}

describe('Human IdP never performs token exchange', () => {
  it('rejects token-exchange with unsupported_grant_type', async () => {
    const response = await tokenRequest('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('unsupported_grant_type');
  });

  it('rejects jwt-bearer', async () => {
    const response = await tokenRequest('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('unsupported_grant_type');
  });

  it('does not import the experimental package anywhere in src', () => {
    const purity = readFileSync(new URL('../../../scripts/check-human-idp-purity.sh', import.meta.url).pathname, 'utf8');
    expect(purity).toContain('@maronn-openid-connect/experimental');
  });
});
