import type { DocumentStore } from '@xaa/gcp';

export const CONSENT_STATE_TTL_SECONDS = 600;
export const ONE_TIME_CODE_TTL_SECONDS = 300;

export interface ConsentState {
  transaction_id: string;
  connector_id: string;
  human_subject: string;
  required_scopes: string[];
  code_verifier: string;
  created_at: string;
  expire_at: string;
}

export interface OneTimeCodeRecord {
  transaction_id: string;
  connection_id: string;
  expire_at: string;
}

export interface ConsentStore {
  putState(state: string, value: Omit<ConsentState, 'created_at' | 'expire_at'>, now?: number): Promise<void>;
  consumeState(state: string): Promise<ConsentState | undefined>;
  putCode(code: string, value: Omit<OneTimeCodeRecord, 'expire_at'>, now?: number): Promise<void>;
  consumeCode(code: string, now?: number): Promise<OneTimeCodeRecord | undefined>;
}

/**
 * State and one-time codes, each usable exactly once.
 *
 * Reading and deleting happen in one transaction. Split into two steps, a replayed
 * callback could pass the read before the delete lands, and the same authorization code
 * would be exchanged twice — which is the whole reason `state` is single-use.
 */
export function createConsentStore(documents: DocumentStore, now: () => number = () => Date.now()): ConsentStore {
  return {
    async putState(state, value, at = now()) {
      await documents.set('bridge_consent_states', state, {
        ...value,
        created_at: new Date(at).toISOString(),
        // Firestore's TTL policy reads this field; a state nobody used disappears.
        expire_at: new Date(at + CONSENT_STATE_TTL_SECONDS * 1000).toISOString(),
      });
    },
    async consumeState(state) {
      return documents.transaction(async (tx) => {
        const value = await tx.get<ConsentState>('bridge_consent_states', state);
        if (!value) return undefined;
        tx.delete('bridge_consent_states', state);
        return value;
      });
    },
    async putCode(code, value, at = now()) {
      await documents.set('bridge_consent_codes', code, {
        ...value,
        expire_at: new Date(at + ONE_TIME_CODE_TTL_SECONDS * 1000).toISOString(),
      });
    },
    async consumeCode(code, at = now()) {
      return documents.transaction(async (tx) => {
        const value = await tx.get<OneTimeCodeRecord>('bridge_consent_codes', code);
        if (!value) return undefined;
        // Deleted even when expired: a code that was presented is spent, whatever the
        // answer, so a second attempt cannot get a different one.
        tx.delete('bridge_consent_codes', code);
        return Date.parse(value.expire_at) <= at ? undefined : value;
      });
    },
  };
}
