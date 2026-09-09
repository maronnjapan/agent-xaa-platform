import { createDpopProof, decodeJwsUnverified } from '@xaa/crypto';
import {
  AGENT_CLIENT_AUTH_ASSERTION_TYPE, findForbiddenSubjectTokenFields, readSubjectToken,
  readSubjectTokenExpiresIn,
} from '@xaa/contracts';
import type { ExecutionContext } from '../context/execution-context.js';
import type { RuntimeHttpClient } from '../http/http-client.js';
import { buildClientAssertion } from './client-assertion.js';

export class UnexpectedSubjectResponse extends Error {
  readonly code = 'unexpected_subject_response';
}

export const SUBJECT_ENDPOINT_PATH = '/xaa/subject-token';
/** Re-fetch before the last minute of life, so an exchange never starts on a stale token. */
export const SUBJECT_REFRESH_MARGIN_MS = 60_000;

/**
 * The human's ID Token, fetched from the Agent OP rather than handed in at startup.
 *
 * DEC-ID-19 is what lets an agent outlive the browser session that created it: the OP
 * holds the IdP connection and mints a fresh subject token on request, so the Runtime
 * never needs — and never receives — a refresh token or a session cookie. For the same
 * reason there is no start-up parameter carrying the human's ID Token: the only way in
 * is this request, and the only way out of the process is the token store.
 *
 * A response carrying `refresh_token` or `access_token` is treated as a failure rather
 * than as extra fields to ignore. It would mean the OP is handing over more than the
 * delegation requires, and the Runtime should not be the component that quietly accepts it.
 *
 * What the OP sends back is `subject_token` under `subject_token_type` (REQ-05-051),
 * not a bare `id_token`; both ends now read those names out of `@xaa/contracts` so the
 * pair cannot drift apart again.
 */
export async function fetchSubjectToken(
  context: ExecutionContext,
  http: RuntimeHttpClient,
  now: number = Date.now(),
): Promise<string> {
  const cached = context.tokens.get('subject', now);
  if (cached) return cached;

  const url = `${context.agentOpBaseUrl}${SUBJECT_ENDPOINT_PATH}`;
  const body = new URLSearchParams({
    client_assertion: await buildClientAssertion(context, SUBJECT_ENDPOINT_PATH, now),
    client_assertion_type: AGENT_CLIENT_AUTH_ASSERTION_TYPE,
  });
  const response = await http.send(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // No `ath`: there is no Access Token to bind this proof to yet.
      DPoP: await createDpopProof({ method: 'POST', url, keyPair: context.dpop, now: () => now }),
    },
    body: body.toString(),
  });
  if (!response.ok) throw new UnexpectedSubjectResponse(`subject token request failed: ${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  const forbidden = findForbiddenSubjectTokenFields(payload);
  if (forbidden.length > 0) {
    throw new UnexpectedSubjectResponse('subject token response carried more than an id_token');
  }
  const idToken = readSubjectToken(payload);
  if (!idToken) throw new UnexpectedSubjectResponse('subject token response has no subject_token');

  // The ID Token's own `exp` is what the Resource AS will read, so it decides the
  // caching; `expires_in` only stands in for a token that carries no `exp` at all.
  const claims = decodeJwsUnverified(idToken).payload;
  const reportedLifetime = readSubjectTokenExpiresIn(payload);
  const expiresAt = typeof claims.exp === 'number'
    ? claims.exp * 1000
    : now + (reportedLifetime ?? SUBJECT_REFRESH_MARGIN_MS / 1000) * 1000;
  context.tokens.set('subject', idToken, expiresAt - SUBJECT_REFRESH_MARGIN_MS + 30_000);
  return idToken;
}
