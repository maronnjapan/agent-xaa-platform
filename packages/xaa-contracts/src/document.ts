/** specs §5.1. Six work-signal sources plus a free-form note, distinguished by `type`. */
export const DOCUMENT_TYPES = ['daily_report', 'work_log', 'mail', 'calendar', 'chat', 'note', 'task'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface StoredDocument {
  document_id: string;
  owner_subject: string;
  type: DocumentType;
  title: string;
  body: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  version: number;
}

export const documentSchema = {
  $id: 'document',
  type: 'object',
  additionalProperties: false,
  required: ['document_id', 'owner_subject', 'type', 'title', 'body', 'occurred_at', 'metadata', 'created_at', 'updated_at', 'version'],
  properties: {
    document_id: { type: 'string', pattern: '^doc_[0-9a-f-]{36}$' },
    owner_subject: { type: 'string', minLength: 1 },
    type: { enum: DOCUMENT_TYPES },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 20_000 },
    occurred_at: { type: 'string', format: 'date-time' },
    metadata: { type: 'object' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    version: { type: 'integer', minimum: 1 },
  },
} as const;

/**
 * `owner_subject`, `document_id` and `version` are absent from the input schema on
 * purpose: the owner is the token's `sub`, the id is minted here and the version is
 * managed by the store. A body that carries them is rejected, not silently ignored.
 */
export const documentCreateSchema = {
  $id: 'document-create',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'body', 'occurred_at'],
  properties: {
    type: { enum: DOCUMENT_TYPES },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 20_000 },
    occurred_at: { type: 'string', format: 'date-time' },
    metadata: { type: 'object' },
  },
} as const;

/** Only the title and the body may change, and only against the version held. */
export const documentPatchSchema = {
  $id: 'document-patch',
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 20_000 },
  },
} as const;
