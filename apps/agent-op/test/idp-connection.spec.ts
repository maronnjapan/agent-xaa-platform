import { describe, expect, it } from 'vitest';
import { createKmsEnvelopeCipher, refreshTokenFingerprint } from '../src/idp-connection/crypto.js';
import { IdpConnectionView } from '../src/idp-connection/repository.js';
import type { IdpConnection } from '../src/store/types.js';

/** Reversible stand-in that mirrors KMS' AAD binding. */
const kmsDouble = {
  async encrypt(request: { plaintext: Buffer; additionalAuthenticatedData: Buffer }) {
    return [{ ciphertext: Buffer.from(`${request.additionalAuthenticatedData.toString('utf8')}::${request.plaintext.toString('utf8')}`) }] as [{ ciphertext: Uint8Array }];
  },
  async decrypt(request: { ciphertext: Buffer; additionalAuthenticatedData: Buffer }) {
    const decoded = request.ciphertext.toString('utf8');
    const aad = request.additionalAuthenticatedData.toString('utf8');
    if (!decoded.startsWith(`${aad}::`)) throw new Error('AAD mismatch');
    return [{ plaintext: Buffer.from(decoded.slice(aad.length + 2)) }] as [{ plaintext: Uint8Array }];
  },
};

const record: IdpConnection = {
  idp_connection_id: 'idpconn-1',
  agent_id: 'agent-abcdefghijklmnopqrstuvwxyz',
  human_subject: 'user-1',
  encrypted_refresh_token: 'Y2lwaGVy',
  granted_scopes: ['openid', 'offline_access'],
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-02T00:00:00Z',
};

describe('IdP connection record', () => {
  it('round-trips through the envelope with the agent id as AAD', async () => {
    const cipher = createKmsEnvelopeCipher('projects/p/keys/k', kmsDouble as never);
    const ciphertext = await cipher.encrypt('rt-1', record.agent_id);
    expect(await cipher.decrypt(ciphertext, record.agent_id)).toBe('rt-1');
  });

  it('decrypt fails when the agent_id AAD differs', async () => {
    const cipher = createKmsEnvelopeCipher('projects/p/keys/k', kmsDouble as never);
    const ciphertext = await cipher.encrypt('rt-1', record.agent_id);
    await expect(cipher.decrypt(ciphertext, 'agent-zzzzzzzzzzzzzzzzzzzzzzzzzz')).rejects.toThrow('AAD mismatch');
  });

  it('JSON.stringify redacts encrypted_refresh_token', () => {
    const serialised = JSON.stringify(new IdpConnectionView(record));
    expect(serialised).toContain('[redacted]');
    expect(serialised).not.toContain('Y2lwaGVy');
    expect(String(new IdpConnectionView(record))).not.toContain('Y2lwaGVy');
  });

  it('has no plaintext refresh_token field', () => {
    const view = new IdpConnectionView(record) as unknown as Record<string, unknown>;
    expect(Object.keys(view)).not.toContain('refresh_token');
    // @ts-expect-error the type has no plaintext member
    void record.refresh_token;
  });

  it('fingerprints a refresh token without revealing it', async () => {
    const fingerprint = await refreshTokenFingerprint('rt-1');
    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).not.toContain('rt-1');
  });
});
