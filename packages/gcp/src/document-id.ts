/**
 * What Firestore accepts as a document id.
 *
 * It lives in one module so the code that builds an id and the double that stands in
 * for Firestore in tests cannot disagree about the limit. A document id over the
 * ceiling is refused by the real service and, until the double checked it too, by
 * nothing at all in this repository.
 *
 * https://cloud.google.com/firestore/quotas#collections_documents_and_fields
 */
export const MAX_DOCUMENT_ID_BYTES = 1500;

export function documentIdByteLength(id: string): number {
  return new TextEncoder().encode(id).byteLength;
}
