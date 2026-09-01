import { randomBytes } from 'node:crypto';
import { sha256Base64Url } from '@xaa/crypto';

/** Five minutes: long enough for a consent screen, short enough to be uninteresting. */
export const COMPLETION_CODE_TTL_SECONDS = 300;

/** RULE-23. The one-time code the consent redirect carries, and the row behind it. */
export interface CompletionCodeRecord {
  code_hash: string;
  transaction_id: string;
  human_subject: string;
  issuer_kind: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/**
 * The code is written by whoever ran the consent and redeemed by the Provisioner, so
 * the two sides have to agree on the collection, the document id and the seven fields.
 * They live here rather than in either app: when they lived in one of them, the other
 * wrote `bridge_consent_codes/{code}` while the Provisioner read
 * `provisioning_codes/{sha256(code)}`, and every consent came back to a code the
 * Provisioner could not find.
 */
export const PROVISIONING_CODES_COLLECTION = 'provisioning_codes';

/** The document id is the code's SHA-256: a leaked database yields no usable code. */
export async function completionCodeId(code: string): Promise<string> {
  return sha256Base64Url(code);
}

export async function createCompletionCode(input: {
  transactionId: string;
  humanSubject: string;
  /** `idp` for the Human IdP consent, otherwise the Connector id (00b). */
  issuerKind: string;
  now?: number;
}): Promise<{ code: string; documentId: string; record: CompletionCodeRecord }> {
  const code = randomBytes(32).toString('base64url');
  const documentId = await completionCodeId(code);
  const issuedAt = input.now ?? Date.now();
  return {
    code,
    documentId,
    record: {
      code_hash: documentId,
      transaction_id: input.transactionId,
      human_subject: input.humanSubject,
      issuer_kind: input.issuerKind,
      created_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + COMPLETION_CODE_TTL_SECONDS * 1000).toISOString(),
      used_at: null,
    },
  };
}
