import type { AdminInput } from '@xaa/admin-ui';
import { DOCUMENT_TYPES, type DocumentType } from '@xaa/contracts';

/** What the console writes when it creates a document. */
export interface DocumentCreateInput {
  ownerSubject: string;
  type: DocumentType;
  title: string;
  body: string;
  occurredAt?: string;
}

/** What the console writes when it edits one. The API patches these two fields only. */
export interface DocumentPatchInput {
  version: number;
  title: string;
  body: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * The bounds are `documentSchema`'s, restated so the console can say which field is
 * wrong. The schema is what actually decides — `create` asserts against it — so these
 * numbers exist to produce a sentence, never to be the rule.
 */
const TITLE_MAX = 200;
const BODY_MAX = 20_000;

/**
 * Turns what somebody typed into a document, reporting every problem at once.
 *
 * The rules are the resource's own, restated in the console's words: `documentCreateSchema`
 * is what actually decides, and this exists so a person gets "タイトルを入力してください"
 * instead of a 400 with a schema path in it. Nothing here is a rule of its own — where the
 * two could disagree, the schema is the one that runs.
 */
export function parseDocumentCreate(input: AdminInput): ParseResult<DocumentCreateInput> {
  const errors: string[] = [];
  const ownerSubject = (input.owner_subject ?? '').trim();
  if (ownerSubject === '') errors.push('owner_subject を入力してください');

  // A closed list, because `type` is closed: the store asserts the document against
  // `documentSchema`, whose `type` is an enum, so a value outside it is not a document
  // that gets written and rejected — it is a 500 from an assertion nobody typed at.
  const type = (input.type ?? '').trim();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) {
    errors.push(`type は ${DOCUMENT_TYPES.join(' / ')} のいずれかです`);
  }

  const title = (input.title ?? '').trim();
  if (title === '') errors.push('タイトルを入力してください');
  else if (title.length > TITLE_MAX) errors.push(`タイトルは ${TITLE_MAX} 文字までです`);

  const body = input.body ?? '';
  if (body.length > BODY_MAX) errors.push(`本文は ${BODY_MAX} 文字までです`);

  const occurredAt = (input.occurred_at ?? '').trim();
  if (occurredAt !== '' && !isInstant(occurredAt)) {
    errors.push('日時は 2026-09-06T09:00 の形（日時入力欄が出す形）で入れてください');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      ownerSubject, type: type as DocumentType, title, body,
      // Left out when blank, so the store stamps the moment of writing rather than the
      // console inventing an instant the person did not choose.
      ...(occurredAt === '' ? {} : { occurredAt: new Date(occurredAt).toISOString() }),
    },
  };
}

export function parseDocumentPatch(input: AdminInput): ParseResult<DocumentPatchInput> {
  const errors: string[] = [];
  const version = Number(input.version ?? '');
  if (!Number.isInteger(version) || version < 1) errors.push('version が壊れている。画面を開き直してください');

  const title = (input.title ?? '').trim();
  if (title === '') errors.push('タイトルを入力してください');
  else if (title.length > TITLE_MAX) errors.push(`タイトルは ${TITLE_MAX} 文字までです`);

  const body = input.body ?? '';
  if (body.length > BODY_MAX) errors.push(`本文は ${BODY_MAX} 文字までです`);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { version, title, body } };
}

/**
 * Whether a string names an instant.
 *
 * `datetime-local` sends `2026-09-06T09:00` with no zone, and `Date.parse` reads that as
 * local time — which is what the person meant, since they typed it on their own clock.
 * The store keeps the UTC instant it converts to.
 */
function isInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** An instant, in the shape a `datetime-local` field reads back. */
export function toLocalInputValue(isoInstant: string): string {
  const millis = Date.parse(isoInstant);
  if (!Number.isFinite(millis)) return '';
  const local = new Date(millis - new Date(millis).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
