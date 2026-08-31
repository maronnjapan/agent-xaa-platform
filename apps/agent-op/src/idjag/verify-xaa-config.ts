import { IdJagError, validateIdJagAudience, validateIdJagScope } from '@maronn-openid-connect/experimental/id-jag';
import type { XaaStaticConfiguration } from '../store/types.js';

/** Never names the allow list: the caller must not be able to enumerate it. */
export const OUT_OF_RANGE = 'The request is outside the static XAA configuration for this agent';

export type XaaConfigField = 'audience' | 'scope' | 'resource';

export interface VerifyXaaConfigInput {
  audience: string;
  scope: string | undefined;
  resource: string | undefined;
  issuer: string;
  config: XaaStaticConfiguration;
  onViolation?: (field: XaaConfigField) => void;
}

/**
 * REQ-05-073. audience, then scope, then resource; the first failure stops the rest so
 * exactly one violation is reported.
 *
 * `audience` is the Resource AS issuer as an https URL, never a URN (DEC-ID-05), and
 * `resource` is an RFC 8707 absolute URI matched by exact equality — a prefix match
 * would let `https://api.test/documents` stand in for `https://api.test/documents-x`.
 */
export function verifyXaaConfig(input: VerifyXaaConfigInput): string[] {
  try {
    validateIdJagAudience({ audience: input.audience, issuer: input.issuer, allowedAudiences: input.config.allowed_audiences });
  } catch {
    input.onViolation?.('audience');
    throw new IdJagError('invalid_scope', OUT_OF_RANGE);
  }

  let granted: string[];
  try {
    // config.scopes is always an array; passing undefined would make the library
    // accept anything, which would silently disable this check.
    granted = validateIdJagScope(input.scope, input.config.scopes);
  } catch {
    input.onViolation?.('scope');
    throw new IdJagError('invalid_scope', OUT_OF_RANGE);
  }

  if (input.resource === undefined || !input.config.resources.includes(input.resource)) {
    input.onViolation?.('resource');
    throw new IdJagError('invalid_scope', OUT_OF_RANGE);
  }
  return granted;
}
