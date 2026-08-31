import type { AgentIdentityDomain } from '../domain.js';
import type { CleanupReason } from '../config.js';
import type { Logger, LogContext } from '@xaa/logging';
import type { DocumentStore } from '@xaa/gcp';

export interface CloudRunClient {
  cancelExecution(name: string): Promise<'cancelled' | 'not_found' | 'already_finished'>;
  deleteService(name: string): Promise<'deleted' | 'not_found'>;
  deleteJob(name: string): Promise<'deleted' | 'not_found'>;
}

export interface KmsClient {
  destroyCryptoKeyVersion(name: string): Promise<'scheduled' | 'not_found'>;
}

export interface IamClient {
  deleteServiceAccount(name: string): Promise<'deleted' | 'not_found'>;
  removeBinding(name: string): Promise<'removed' | 'not_found'>;
}

export interface JwksBucketClient {
  deleteKey(objectName: string): Promise<void>;
}

export interface AgentOpClient {
  disableIssuance(input: { baseUrl: string; agentId: string }): Promise<number>;
  revokeIdpConnection(input: { baseUrl: string; agentId: string; connectionId: string }): Promise<number>;
  revokeClientCredential(input: { baseUrl: string; agentId: string }): Promise<number>;
  deleteRegistration(input: { baseUrl: string; agentId: string }): Promise<number>;
}

export interface ResourceAsClient {
  revokeByActor(input: { baseUrl: string; actorSub: string }): Promise<number>;
}

export interface BridgeClient {
  disableBinding(input: { baseUrl: string; bindingId: string }): Promise<number>;
  revokeUpstream(input: { baseUrl: string; connectionId: string }): Promise<number>;
}

export interface ProvisionerClient {
  reprovision(input: { baseUrl: string; body: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface CleanupClients {
  cloudRun: CloudRunClient;
  kms: KmsClient;
  iam: IamClient;
  jwks: JwksBucketClient;
  agentOp: AgentOpClient;
  resourceAs: ResourceAsClient;
  bridge: BridgeClient;
  endpoints: {
    agentOpUrl: string;
    docsAsUrl: string;
    financeAsUrl: string;
    bridgeUrl: string | null;
  };
}

export interface CleanupContext {
  domain: AgentIdentityDomain;
  reason: CleanupReason;
  clients: CleanupClients;
  logger: Logger;
  logContext: LogContext;
  documents: DocumentStore;
  now: () => number;
}
