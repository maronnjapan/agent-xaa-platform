import { compile, paymentSchema, type PaymentStatus, type StoredPayment } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';

const assertPayment: (value: unknown) => asserts value is StoredPayment = compile<StoredPayment>(paymentSchema);

export class InvalidState extends Error {
  constructor(readonly status: PaymentStatus) { super('invalid_state'); }
}

export interface ApprovalSubjects {
  /** The delegating human, from the ID-JAG `sub`. */
  approvedBy: string;
  /** The agent that acted, from `act.sub`, in urn:xaa:agent: form. */
  approvedByAgent: string;
}

export type ApprovalResult =
  | { outcome: 'approved' | 'already_approved'; payment: StoredPayment }
  | { outcome: 'not_found' };

export function createPaymentRepository(store: DocumentStore, now: () => number = () => Date.now()) {
  return {
    async list(requesterSubject: string, options: { status?: string; limit: number }): Promise<StoredPayment[]> {
      const rows = await store.queryEqual<StoredPayment>('payments', [['requester_subject', requesterSubject]]);
      return rows
        .map(({ data }) => data)
        .filter((payment) => options.status === undefined || payment.status === options.status)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, options.limit);
    },

    async get(paymentId: string, requesterSubject: string): Promise<StoredPayment | undefined> {
      const payment = await store.get<StoredPayment>('payments', paymentId);
      return payment && payment.requester_subject === requesterSubject ? payment : undefined;
    },

    /**
     * Idempotent by design: a repeated approval returns the first one unchanged
     * rather than an error, because a retried tool call must not look like a
     * failure. Approving from `rejected` or `executed` is a genuine state error.
     *
     * RULE-46: both the human and the agent are recorded, and neither comes from
     * the request body.
     */
    async approve(paymentId: string, requesterSubject: string, subjects: ApprovalSubjects): Promise<ApprovalResult> {
      return store.transaction(async (tx) => {
        const current = await tx.get<StoredPayment>('payments', paymentId);
        if (!current || current.requester_subject !== requesterSubject) return { outcome: 'not_found' };
        if (current.status === 'approved') return { outcome: 'already_approved', payment: current };
        if (current.status !== 'pending_approval') throw new InvalidState(current.status);
        const next: StoredPayment = {
          ...current,
          status: 'approved',
          approved_by: subjects.approvedBy,
          approved_by_agent: subjects.approvedByAgent,
          approved_at: new Date(now()).toISOString(),
        };
        assertPayment(next);
        tx.set('payments', paymentId, { ...next });
        return { outcome: 'approved', payment: next };
      });
    },
  };
}
