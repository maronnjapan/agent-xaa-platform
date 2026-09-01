import { randomBytes } from 'node:crypto';
import { compile, type IsolationLevel } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { isTerminal, transition, TRANSACTION_STATUSES, TRANSACTION_TTL_SECONDS, type TransactionStatus } from './state.js';

export interface ProvisioningTransaction {
  transaction_id: string;
  human_subject: string;
  agent_id: string | null;
  required_capabilities: string[];
  required_connectors: string[];
  isolation_level: IsolationLevel;
  status: TransactionStatus;
  pending_step: string | null;
  dedicated_short_id: string | null;
  /** The last Activity Event number handed out for this transaction (T-PROV-32). */
  sequence: number;
  created_at: string;
  expires_at: string;
}

export const provisioningTransactionSchema = {
  $id: 'provisioning-transaction',
  type: 'object',
  additionalProperties: false,
  required: ['transaction_id', 'human_subject', 'agent_id', 'required_capabilities', 'required_connectors', 'isolation_level', 'status', 'pending_step', 'dedicated_short_id', 'sequence', 'created_at', 'expires_at'],
  properties: {
    transaction_id: { type: 'string', pattern: '^txn_[A-Za-z0-9_-]{22}$' },
    human_subject: { type: 'string', minLength: 1 },
    agent_id: { type: ['string', 'null'] },
    required_capabilities: { type: 'array', items: { type: 'string' } },
    required_connectors: { type: 'array', items: { type: 'string' } },
    isolation_level: { enum: ['standard', 'full_isolation'] },
    status: { enum: TRANSACTION_STATUSES },
    pending_step: { type: ['string', 'null'] },
    dedicated_short_id: { type: ['string', 'null'] },
    sequence: { type: 'integer', minimum: 0 },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

const assertTransaction: (value: unknown) => asserts value is ProvisioningTransaction =
  compile<ProvisioningTransaction>(provisioningTransactionSchema);

export function newTransactionId(): string {
  return `txn_${randomBytes(16).toString('base64url')}`;
}

export interface TransactionStore {
  create(input: Omit<ProvisioningTransaction, 'transaction_id' | 'status' | 'sequence' | 'created_at' | 'expires_at'>): Promise<ProvisioningTransaction>;
  find(transactionId: string): Promise<ProvisioningTransaction | undefined>;
  advance(transactionId: string, to: TransactionStatus, patch?: Partial<ProvisioningTransaction>): Promise<ProvisioningTransaction>;
  abandon(transactionId: string): Promise<ProvisioningTransaction | undefined>;
  /** Moves the resume point without changing the status (T-PROV-28). */
  markStep(transactionId: string, pendingStep: string): Promise<void>;
  /** Hands out the next Activity Event number, once, even under concurrent emitters. */
  nextSequence(transactionId: string): Promise<number>;
}

export function createTransactionStore(documents: DocumentStore, now: () => number = () => Date.now()): TransactionStore {
  const load = async (transactionId: string) =>
    documents.get<ProvisioningTransaction>('provisioning_transactions', transactionId);

  return {
    async create(input) {
      const createdAt = now();
      const record: ProvisioningTransaction = {
        ...input,
        transaction_id: newTransactionId(),
        status: 'CREATED',
        sequence: 0,
        created_at: new Date(createdAt).toISOString(),
        expires_at: new Date(createdAt + TRANSACTION_TTL_SECONDS * 1000).toISOString(),
      };
      assertTransaction(record);
      await documents.set('provisioning_transactions', record.transaction_id, { ...record });
      return record;
    },

    async find(transactionId) { return load(transactionId); },

    async advance(transactionId, to, patch = {}) {
      const current = await load(transactionId);
      if (!current) throw new Error(`unknown transaction: ${transactionId}`);
      const next: ProvisioningTransaction = { ...current, ...patch, status: transition(current.status, to) };
      assertTransaction(next);
      // Only the changed fields are written: `sequence` is advanced by a different
      // writer, and a whole-document overwrite would put back the number this call read.
      await documents.update('provisioning_transactions', transactionId, { ...patch, status: next.status });
      return next;
    },

    /**
     * Called by the Lifecycle sweep when a consent never came back. Idempotent: a
     * second call on an already-abandoned transaction changes nothing, so a retried
     * sweep cannot release the same resources twice.
     */
    async abandon(transactionId) {
      const current = await load(transactionId);
      if (!current) return undefined;
      if (isTerminal(current.status)) return current;
      const next: ProvisioningTransaction = { ...current, status: transition(current.status, 'ABANDONED') };
      await documents.update('provisioning_transactions', transactionId, { status: next.status });
      return next;
    },

    async markStep(transactionId, pendingStep) {
      await documents.update('provisioning_transactions', transactionId, { pending_step: pendingStep });
    },

    async nextSequence(transactionId) {
      return documents.transaction(async (tx) => {
        const current = await tx.get<ProvisioningTransaction>('provisioning_transactions', transactionId);
        if (!current) throw new Error(`unknown transaction: ${transactionId}`);
        const sequence = (current.sequence ?? 0) + 1;
        tx.update('provisioning_transactions', transactionId, { sequence });
        return sequence;
      });
    },
  };
}
