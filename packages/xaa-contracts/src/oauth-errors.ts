export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'invalid_scope',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_dpop_proof',
  'replayed_dpop_proof',
  'dpop_key_binding_mismatch',
  'insufficient_scope',
  'insufficient_isolation',
  'constraint_violation',
  'tool_not_allowed',
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export const FIXED_DESCRIPTIONS: Record<OAuthErrorCode, string> = Object.fromEntries(
  OAUTH_ERROR_CODES.map((code) => [code, 'The request could not be accepted.']),
) as Record<OAuthErrorCode, string>;

export function oauthErrorResponse(code: OAuthErrorCode, status: number): Response {
  return Response.json({ error: code }, { status });
}

export function mapIdJagError(error: unknown): { code: OAuthErrorCode; internalReason: string } {
  const reason = error instanceof Error ? error.message : 'unknown';
  const normalized = reason.toLowerCase();
  const code = /audience|scope|resource/.test(normalized) ? 'invalid_scope' : 'invalid_grant';
  return { code, internalReason: reason };
}
