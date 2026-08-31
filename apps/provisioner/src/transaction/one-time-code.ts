import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Base64Url } from '@xaa/crypto';
import type { DocumentStore } from '@xaa/gcp';

/** Five minutes: long enough for a consent screen, short enough to be uninteresting. */
export const COMPLETION_CODE_TTL_SECONDS = 300;

export interface CompletionCodeRecord {
  code_hash: string;
  transaction_id: string;
  human_subject: string;
  issuer_kind: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

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
export function createCompletionCodes(documents: DocumentStore, now: () => number = () => Date.now()) {
  return {
    async issue(input: { transaction_id: string; human_subject: string; issuer_kind: string }): Promise<string> {
      const code = randomBytes(32).toString('base64url');
      const codeHash = await sha256Base64Url(code);
      const issuedAt = now();
      const record: CompletionCodeRecord = {
        code_hash: codeHash,
        transaction_id: input.transaction_id,
        human_subject: input.human_subject,
        issuer_kind: input.issuer_kind,
        created_at: new Date(issuedAt).toISOString(),
        expires_at: new Date(issuedAt + COMPLETION_CODE_TTL_SECONDS * 1000).toISOString(),
        used_at: null,
      };
      await documents.set('provisioning_codes', codeHash, { ...record });
      return code;
    },

    async consume(input: { code: string; transaction_id: string; human_subject: string }): Promise<ConsumeResult> {
      const codeHash = await sha256Base64Url(input.code);
      return documents.transaction(async (tx) => {
        const record = await tx.get<CompletionCodeRecord>('provisioning_codes', codeHash);
        if (!record) return { ok: false, status: 400, error: 'code_not_found' };
        // Ownership is checked before the code is marked used, so a wrong caller
        // cannot burn someone else's code.
        if (!equals(record.human_subject, input.human_subject)) return { ok: false, status: 403, error: 'code_owner_mismatch' };
        if (!equals(record.transaction_id, input.transaction_id)) return { ok: false, status: 400, error: 'code_transaction_mismatch' };
        if (record.used_at !== null) return { ok: false, status: 400, error: 'code_already_used' };
        if (Date.parse(record.expires_at) <= now()) return { ok: false, status: 400, error: 'code_expired' };
        tx.set('provisioning_codes', codeHash, { ...record, used_at: new Date(now()).toISOString() });
        return { ok: true, record: { ...record, used_at: new Date(now()).toISOString() } };
      });
    },
  };
}
