import type { IsolationLevel } from '@xaa/contracts';

/** docs 05 §3.4. Registration and static configuration are separate types on purpose. */
export interface AgentRegistration {
  agent_id: string;
  human_subject: string;
  client_auth: { method: 'client_assertion_jwt'; jwk_thumbprint: string; public_jwk: JsonWebKey };
  idp_connection_id: string;
  isolation_level: IsolationLevel;
  /** Present only for FULL_ISOLATION agents; the shared OP leaves it null. */
  dedicated_op: string | null;
  status: 'ACTIVE' | 'EXPIRING' | 'QUARANTINED' | 'REVOKED' | 'EXPIRED';
  created_at: string;
  expires_at: string;
  /** Structural discriminator: never assignable from XaaStaticConfiguration. */
  readonly __kind?: 'agent-registration';
}

export interface XaaStaticConfiguration {
  agent_id: string;
  allowed_audiences: string[];
  resources: string[];
  scopes: string[];
  trusted_resource_as: string[];
  expires_at: string;
  readonly __kind?: 'xaa-static-configuration';
}

export interface IssuerProfile {
  issuer: string;
  kms_key_name: string;
  kid: string;
}

export interface IdpConnection {
  idp_connection_id: string;
  agent_id: string;
  human_subject: string;
  /** KMS ciphertext, base64. No plaintext field exists on this type by design. */
  encrypted_refresh_token: string;
  granted_scopes: string[];
  status: 'ACTIVE' | 'REVOKED';
  created_at: string;
  expires_at: string;
}
