/** specs §5.2. The lifecycle a payment moves through; approval is the only transition an agent can drive. */
export const PAYMENT_STATUSES = ['pending_approval', 'approved', 'rejected', 'executed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface StoredPayment {
  payment_id: string;
  requester_subject: string;
  /** Minor units, integer only: a float amount is a rounding bug waiting to happen. */
  amount: number;
  currency: 'JPY';
  counterparty: string;
  status: PaymentStatus;
  memo: string;
  /** Written only by the approval path; absent from every input schema. */
  approved_by: string | null;
  approved_by_agent: string | null;
  approved_at: string | null;
  created_at: string;
}

export const paymentSchema = {
  $id: 'payment',
  type: 'object',
  additionalProperties: false,
  required: ['payment_id', 'requester_subject', 'amount', 'currency', 'counterparty', 'status', 'memo', 'approved_by', 'approved_by_agent', 'approved_at', 'created_at'],
  properties: {
    payment_id: { type: 'string', pattern: '^pay_[0-9a-f-]{36}$' },
    requester_subject: { type: 'string', minLength: 1 },
    amount: { type: 'integer', minimum: 1 },
    currency: { const: 'JPY' },
    counterparty: { type: 'string', minLength: 1 },
    status: { enum: PAYMENT_STATUSES },
    memo: { type: 'string' },
    approved_by: { type: ['string', 'null'] },
    approved_by_agent: { type: ['string', 'null'] },
    approved_at: { type: ['string', 'null'], format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * The seed input. There is no create endpoint on the Resource API (specs §5.2 lists
 * three operations, none of which is create), so this shape is only ever used by the
 * seed job. The three approval fields are deliberately not present.
 */
export const paymentSeedSchema = {
  $id: 'payment-seed',
  type: 'object',
  additionalProperties: false,
  required: ['requester_subject', 'amount', 'currency', 'counterparty', 'memo'],
  properties: {
    requester_subject: { type: 'string', minLength: 1 },
    amount: { type: 'integer', minimum: 1 },
    currency: { const: 'JPY' },
    counterparty: { type: 'string', minLength: 1 },
    memo: { type: 'string' },
  },
} as const;
