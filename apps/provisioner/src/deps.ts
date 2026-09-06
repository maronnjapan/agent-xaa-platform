import type { ActivityEvent } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import type { Logger } from '@xaa/logging';
import type { JobRunner } from './job/execute.js';
import type { TransactionStore } from './transaction/store.js';
import type { createDedicatedLedger } from './dedicated-ledger.js';
import type { DedicatedResult } from './dedicated.js';

export interface ProvisionerConfig {
  port: number;
  issuer: string;
  jwksUrl: string;
  audience: string;
  publicBaseUrl: string;
  sharedAgentOpUrl: string;
  standardJobName: string;
  agentMaxLifetimeSeconds: number;
  maxFullIsolationAgents: number;
  activityTopic: string;
  dpopIatSkewSeconds: number;
  /** Service-account emails allowed on `/internal/*`; empty refuses every caller. */
  internalCallers: string[];
  /** Accounts allowed on the mapping console; empty refuses every caller. */
  adminPrincipals: string[];
}

export interface IdpConnectionResult {
  status: 'READY' | 'CONSENT_REQUIRED';
  consentUrl: string;
}

export type BridgeConnectionCheck =
  | { status: 'READY'; connection_id: string }
  | { status: 'CONSENT_REQUIRED'; consent_url: string; missing_scopes: string[] };

/**
 * The three calls a provisioning makes against the Bridge (T-PROV-16, 00b §4). The
 * Bridge's other five internal routes belong to the Agent Runtime and to Lifecycle;
 * this service can start a connection and narrow one, and cannot mint a token or take
 * a binding away.
 */
export interface BridgeClient {
  checkConnection(input: {
    connectorId: string;
    humanSubject: string;
    requiredScopes: string[];
    transactionId: string;
  }): Promise<BridgeConnectionCheck>;
  verifyConnection(input: {
    transactionId: string;
    oneTimeCode: string;
  }): Promise<{ status: string; connection_id: string; granted_scopes: string[] }>;
  createBinding(input: {
    agentId: string;
    connectorId: string;
    connectionId: string;
    humanSubject: string;
    scopes: string[];
    expiresAt: string;
  }): Promise<{ binding_id: string; expires_at: string }>;
}

export interface ProvisionerDeps {
  config: ProvisionerConfig;
  documents: DocumentStore;
  transactions: TransactionStore;
  jobs: JobRunner;
  clock: { now(): number };
  logger?: Logger;
  /** Test seam for the Activity topic; production publishes through @xaa/contracts. */
  publishActivity?: (event: ActivityEvent) => Promise<void>;
  /** Verifies a Google-issued OIDC ID Token; injected so tests need no Google JWKS. */
  verifyInternalCaller?: (token: string, audience: string) => Promise<string | null>;
  /** The same seam for the console, whose callers are people rather than services. */
  verifyAdmin?: (token: string, audience: string) => Promise<string | null>;
  /** Agent OP owns the refresh token; the Provisioner only asks for a connection. */
  agentOp: {
    createIdpConnection(input: {
      agentId: string;
      humanSubject: string;
      idpConnectionId: string;
      expiresAt: string;
      transactionId: string;
    }): Promise<IdpConnectionResult>;
    verifyIdpConnection(idpConnectionId: string): Promise<{ status: string }>;
    /** Compensation for `idp_consent`: the connection outlives the failed run otherwise. */
    revokeIdpConnection?(idpConnectionId: string): Promise<void>;
  };
  /**
   * Present only where the Bridge is deployed (DEC-SCOPE-04).
   *
   * Optional rather than a stub that refuses, because the two states are different
   * facts and only one of them is a problem. With the Bridge off, the seed leaves the
   * bridged catalogue rows out, no agent can be resolved to a bridged tool, and nothing
   * ever reaches for this. With the Bridge on and this absent, a bridged provisioning
   * has to stop and say so rather than build an agent whose first SaaS call will fail.
   */
  bridge?: BridgeClient;
  /** Only reached from the full_isolation branch (T-PROV-27). */
  createDedicated: (input: {
    agentId: string; expiresAt: string; taskTimeoutSeconds: number;
    ledger: ReturnType<typeof createDedicatedLedger>;
  }) => Promise<DedicatedResult>;
}
