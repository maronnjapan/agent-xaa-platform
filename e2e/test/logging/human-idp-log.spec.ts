import { describe, expect, it } from 'vitest';
import { createDpopProof, generateEs256KeyPair } from '@xaa/crypto';
import { authorize, tokenRequest } from '../../harness/oauth-flow.js';
import { AUTOMATION_REDIRECT_URI, HUMAN_IDP_ISSUER, startHumanIdp } from '../../harness/human-idp.js';

const COMMON = ['human_subject', 'agent_id', 'trace_id', 'timestamp'];
const SPECIFIC = ['client_id', 'audience', 'scope', 'auth_result', 'failure_code', 'dpop_status', 'source_ip', 'user_agent'];

describe('Human IdP audit log', () => {
  it('emits every field on success and on failure, and never a raw token', async () => {
    const lines: string[] = [];
    const idp = await startHumanIdp({}, lines);
    const keyPair = await generateEs256KeyPair();

    const ok = await authorize({
      fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
      scope: 'openid agent:provision', issuer: HUMAN_IDP_ISSUER,
    });
    await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
      dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
      form: {
        grant_type: 'authorization_code', code: ok.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
        code_verifier: ok.pkce.verifier, client_id: 'automation-app',
      },
    });

    const failed = await authorize({
      fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
      scope: 'openid agent:destroy', issuer: HUMAN_IDP_ISSUER,
    });
    expect(failed.error).toBe('invalid_scope');

    const written = lines.map((line) => JSON.parse(line) as { log_source: string; fields: Record<string, unknown> });
    // The envelope first: a line without `log_source` is dropped by the Log Sink and
    // never reaches the detector, whatever it says (T-SEC-05).
    expect(written.every((entry) => entry.log_source === 'human_idp')).toBe(true);
    const entries = written.map((entry) => ({ ...entry, ...entry.fields }) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of entries) {
      for (const field of [...COMMON, ...SPECIFIC]) expect(Object.keys(entry)).toContain(field);
      expect(entry.agent_id).toBeNull();
    }
    expect(lines.join('\n')).not.toMatch(/eyJ/);

    const success = entries.filter((entry) => entry.auth_result === 'success');
    const failure = entries.filter((entry) => entry.auth_result === 'failure');
    expect(success.every((entry) => entry.failure_code === null)).toBe(true);
    expect(failure).toHaveLength(1);
    expect(['invalid_client', 'invalid_scope', 'invalid_target', 'invalid_dpop_proof']).toContain(failure[0]!.failure_code);
  });

  it('reports dpop_status valid at /token and not_applicable at /authorize', async () => {
    const lines: string[] = [];
    const idp = await startHumanIdp({}, lines);
    const keyPair = await generateEs256KeyPair();
    const ok = await authorize({
      fetch: idp.fetch, clientId: 'automation-app', redirectUri: AUTOMATION_REDIRECT_URI,
      scope: 'openid agent:provision', issuer: HUMAN_IDP_ISSUER,
    });
    await tokenRequest({
      fetch: idp.fetch, clientId: 'automation-app', clientSecret: 'automation-secret', issuer: HUMAN_IDP_ISSUER,
      dpop: { createProof: (method, url) => createDpopProof({ method, url, keyPair }) },
      form: {
        grant_type: 'authorization_code', code: ok.code!, redirect_uri: AUTOMATION_REDIRECT_URI,
        code_verifier: ok.pkce.verifier, client_id: 'automation-app',
      },
    });
    const statuses = lines.map((line) => (JSON.parse(line) as {
      fields: { dpop_status: string; scope: string | null };
    }).fields);
    expect(statuses.some((entry) => entry.dpop_status === 'not_applicable')).toBe(true);
    expect(statuses.some((entry) => entry.dpop_status === 'valid')).toBe(true);
  });
});
