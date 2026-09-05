import { TOKEN_TYPE_ID_TOKEN } from './grant-types.js';

/**
 * The body of `POST /xaa/subject-token` (REQ-05-051), written down once.
 *
 * Agent OP answered `{ subject_token, subject_token_type, expires_in }` while the
 * Agent Runtime read `payload.id_token`, so every execution died at the first tool
 * call with `subject token response has no id_token` and the Cloud Run Job Execution
 * ended without doing any work. Both sides had passing tests: the OP's asserted the
 * three keys it sends, the Runtime's mocked the one key it read, and no test crossed
 * the boundary between them.
 *
 * So the names live here rather than in either app, next to the same reasoning as
 * `client-assertion-type.ts`: the OP builds its answer with `buildSubjectTokenResponse`
 * and the Runtime takes it apart with `readSubjectToken`, and a rename that reached
 * only one of them would not compile.
 */
export const SUBJECT_TOKEN_FIELD = 'subject_token';
export const SUBJECT_TOKEN_TYPE_FIELD = 'subject_token_type';
export const SUBJECT_TOKEN_EXPIRES_IN_FIELD = 'expires_in';

/** Human IdP's default ID Token life, used when its answer does not say. */
export const SUBJECT_TOKEN_DEFAULT_EXPIRES_IN = 3600;

/**
 * The two credentials that must never appear in this response. DEC-ID-19 puts the
 * refresh token in the OP and nowhere else, so an answer carrying either one is a
 * failure on both sides rather than extra fields to ignore.
 */
export const SUBJECT_TOKEN_FORBIDDEN_FIELDS = ['access_token', 'refresh_token'] as const;

export interface SubjectTokenResponse {
  readonly subject_token: string;
  readonly subject_token_type: typeof TOKEN_TYPE_ID_TOKEN;
  readonly expires_in: number;
}

/** The OP's answer, built from Human IdP's `id_token` and nothing else it returned. */
export function buildSubjectTokenResponse(input: { idToken: string; expiresIn?: number }): SubjectTokenResponse {
  return {
    [SUBJECT_TOKEN_FIELD]: input.idToken,
    [SUBJECT_TOKEN_TYPE_FIELD]: TOKEN_TYPE_ID_TOKEN,
    [SUBJECT_TOKEN_EXPIRES_IN_FIELD]: input.expiresIn ?? SUBJECT_TOKEN_DEFAULT_EXPIRES_IN,
  };
}

/**
 * The ID Token out of that answer, or `undefined` if this is not that answer.
 *
 * The type field is checked, not skipped: `subject_token` names the role the token
 * plays in the exchange, and only `subject_token_type` says the value under it is an
 * ID Token rather than some other credential handed back under a familiar key.
 */
export function readSubjectToken(payload: Record<string, unknown>): string | undefined {
  if (payload[SUBJECT_TOKEN_TYPE_FIELD] !== TOKEN_TYPE_ID_TOKEN) return undefined;
  const token = payload[SUBJECT_TOKEN_FIELD];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** Names the forbidden credentials present in a subject-token response, if any. */
export function findForbiddenSubjectTokenFields(payload: Record<string, unknown>): string[] {
  return SUBJECT_TOKEN_FORBIDDEN_FIELDS.filter((field) => Object.hasOwn(payload, field));
}

/** The `expires_in` the OP reported, when it reported a usable one. */
export function readSubjectTokenExpiresIn(payload: Record<string, unknown>): number | undefined {
  const value = payload[SUBJECT_TOKEN_EXPIRES_IN_FIELD];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
