/** docs 07 §3.2. The eight states a provisioning attempt can be in (00b). */
export const TRANSACTION_STATUSES = [
  'CREATED', 'WAITING_IDP_CONSENT', 'WAITING_EXTERNAL_CONSENT', 'RESUMABLE',
  'PROVISIONING', 'COMPLETED', 'FAILED', 'ABANDONED',
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** Half an hour, fixed. A consent that has not come back by then is not coming. */
export const TRANSACTION_TTL_SECONDS = 1800;

/**
 * Only these transitions exist. Anything else — most importantly, resurrecting a
 * finished transaction — throws, so a bug cannot walk an agent back into
 * provisioning after it completed or failed.
 */
const ALLOWED: Readonly<Record<TransactionStatus, readonly TransactionStatus[]>> = {
  CREATED: ['WAITING_IDP_CONSENT', 'WAITING_EXTERNAL_CONSENT', 'PROVISIONING', 'FAILED', 'ABANDONED'],
  WAITING_IDP_CONSENT: ['RESUMABLE', 'FAILED', 'ABANDONED'],
  WAITING_EXTERNAL_CONSENT: ['RESUMABLE', 'FAILED', 'ABANDONED'],
  RESUMABLE: ['PROVISIONING', 'WAITING_EXTERNAL_CONSENT', 'FAILED', 'ABANDONED'],
  PROVISIONING: ['COMPLETED', 'FAILED', 'ABANDONED'],
  COMPLETED: [],
  FAILED: [],
  ABANDONED: [],
};

export const TERMINAL_STATUSES: readonly TransactionStatus[] = ['COMPLETED', 'FAILED', 'ABANDONED'];

export class InvalidTransactionTransition extends Error {
  constructor(readonly from: TransactionStatus, readonly to: TransactionStatus) {
    super(`invalid_transaction_transition: ${from} -> ${to}`);
  }
}

export function transition(from: TransactionStatus, to: TransactionStatus): TransactionStatus {
  if (!ALLOWED[from].includes(to)) throw new InvalidTransactionTransition(from, to);
  return to;
}

export function isTerminal(status: TransactionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
