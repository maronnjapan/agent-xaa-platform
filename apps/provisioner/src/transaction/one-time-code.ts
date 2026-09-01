import { timingSafeEqual } from 'node:crypto';
import {
  COMPLETION_CODE_TTL_SECONDS, completionCodeId, createCompletionCode, emitProtocolValidation,
  PROVISIONING_CODES_COLLECTION, type CompletionCodeRecord,
} from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import type { Logger } from '@xaa/logging';

export { COMPLETION_CODE_TTL_SECONDS };
export type { CompletionCodeRecord };

export type ConsumeFailure =
  | { ok: false; status: 400; error: 'code_expired' | 'code_already_used' | 'code_transaction_mismatch' | 'code_not_found' }
  | { ok: false; status: 403; error: 'code_owner_mismatch' };

export type ConsumeResult = { ok: true; record: CompletionCodeRecord } | ConsumeFailure;

/** Constant-time comparison, even for hashes: a timing signal is a signal. */
function equals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * RULE-23. The redirect back from a consent screen carries a transaction id and this
 * code — never a token.
 *
 * Only the code's SHA-256 is stored, so a leaked database does not yield usable
 * codes. Consumption happens inside a transaction, so ten simultaneous redemptions
 * still produce exactly one success.
 */
export function createCompletionCodes(documents: DocumentStore, now: () => number = () => Date.now(), logger?: Logger) {
  return {
    async issue(input: { transaction_id: string; human_subject: string; issuer_kind: string }): Promise<string> {
      const issued = await createCompletionCode({
        transactionId: input.transaction_id,
        humanSubject: input.human_subject,
        issuerKind: input.issuer_kind,
        now: now(),
      });
      await documents.set(PROVISIONING_CODES_COLLECTION, issued.documentId, { ...issued.record });
      return issued.code;
    },

    async consume(input: { code: string; transaction_id: string; human_subject: string }): Promise<ConsumeResult> {
      const codeHash = await completionCodeId(input.code);
      const result = await documents.transaction(async (tx) => {
        const record = await tx.get<CompletionCodeRecord>(PROVISIONING_CODES_COLLECTION, codeHash);
        if (!record) return { ok: false, status: 400, error: 'code_not_found' };
        // Ownership is checked before the code is marked used, so a wrong caller
        // cannot burn someone else's code.
        if (!equals(record.human_subject, input.human_subject)) return { ok: false, status: 403, error: 'code_owner_mismatch' };
        if (!equals(record.transaction_id, input.transaction_id)) return { ok: false, status: 400, error: 'code_transaction_mismatch' };
        if (record.used_at !== null) return { ok: false, status: 400, error: 'code_already_used' };
        if (Date.parse(record.expires_at) <= now()) return { ok: false, status: 400, error: 'code_expired' };
        tx.set(PROVISIONING_CODES_COLLECTION, codeHash, { ...record, used_at: new Date(now()).toISOString() });
        return { ok: true, record: { ...record, used_at: new Date(now()).toISOString() } };
      }) as ConsumeResult;

      // A second redemption of a code is one of the 22 protocol violations (00b §1):
      // either the browser replayed the redirect, or someone else has the code. The
      // code itself stays out of the event — neither in the clear nor as its hash —
      // because a violation report is not a place to put a credential.
      if (!result.ok && result.error === 'code_already_used' && logger) {
        emitProtocolValidation(logger, {
          request_id: '', trace_id: input.transaction_id, agent_id: null, human_subject: input.human_subject,
        }, {
          code: 'code_already_used',
          outcome: 'fail',
          validation_name: 'one_time_code',
          human_subject: input.human_subject,
          agent_id: null,
          occurred_at: new Date(now()).toISOString(),
          path: 'provisioner:/provisioning/{transaction_id}/resume',
          trace_id: input.transaction_id,
        });
      }
      return result;
    },
  };
}
