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
  publishActivity?: (event: Record<string, unknown>) => Promise<void>;
  /** Agent OP owns the refresh token; the Provisioner only asks for a connection. */
  agentOp: {
    createIdpConnection(input: { agentId: string; humanSubject: string; idpConnectionId: string; expiresAt: string }): Promise<IdpConnectionResult>;
    verifyIdpConnection(idpConnectionId: string): Promise<{ status: string }>;
  };
  /** Only reached from the full_isolation branch (T-PROV-27). */
  createDedicated: (input: {
    agentId: string; expiresAt: string; taskTimeoutSeconds: number;
    ledger: ReturnType<typeof createDedicatedLedger>;
  }) => Promise<DedicatedResult>;
}
