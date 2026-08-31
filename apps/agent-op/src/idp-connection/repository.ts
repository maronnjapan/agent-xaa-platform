import type { IdpConnection } from '../store/types.js';

/**
 * A view over the stored record that redacts the ciphertext when it is serialised.
 * Accidentally logging the whole object is a common way for secrets to escape; the
 * type closes that path rather than relying on reviewers to notice.
 */
export class IdpConnectionView implements IdpConnection {
  readonly idp_connection_id: string;
  readonly agent_id: string;
  readonly human_subject: string;
  readonly encrypted_refresh_token: string;
  readonly granted_scopes: string[];
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly created_at: string;
  readonly expires_at: string;

  constructor(record: IdpConnection) {
    this.idp_connection_id = record.idp_connection_id;
    this.agent_id = record.agent_id;
    this.human_subject = record.human_subject;
    this.encrypted_refresh_token = record.encrypted_refresh_token;
    this.granted_scopes = record.granted_scopes;
    this.status = record.status;
    this.created_at = record.created_at;
    this.expires_at = record.expires_at;
  }

  toJSON(): Record<string, unknown> {
    return { ...({ ...this } as Record<string, unknown>), encrypted_refresh_token: '[redacted]' };
  }

  toString(): string { return JSON.stringify(this); }
}
