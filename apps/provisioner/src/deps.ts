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
  /** Only reached from the full_isolation branch (T-PROV-27). */
  createDedicated: (input: {
    agentId: string; expiresAt: string; taskTimeoutSeconds: number;
    ledger: ReturnType<typeof createDedicatedLedger>;
  }) => Promise<DedicatedResult>;
}
