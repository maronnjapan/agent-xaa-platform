import {
  IdJagError, resolveIdJagSubject, SUBJECT_TOKEN_INVALID_DESCRIPTION,
  type IdJagSubject,
} from '@maronn-openid-connect/experimental/id-jag';
import type { JwkSet } from '../keys/shared-jwks.js';

/**
 * REQ-05-068. The library reports a bad subject_token as invalid_request; docs asks
 * for invalid_grant, so exactly that one case is remapped and other invalid_request
 * failures (a missing parameter, say) are left alone.
 *
 * The JWK Set passed in is the `idp-` only view (DEC-ID-20). Handing over the full
 * set would let a JWT signed with this OP's own ID-JAG key pass as a subject_token.
 * The description stays constant so signature, iss, aud and exp failures are
 * indistinguishable from outside.
 */
export async function resolveSubject(options: {
  subjectToken: string;
  issuer: string;
  clientId: string;
  jwks: JwkSet;
}): Promise<IdJagSubject> {
  try {
    return await resolveIdJagSubject({
      subjectToken: options.subjectToken,
      issuer: options.issuer,
      clientId: options.clientId,
      jwks: options.jwks as never,
    });
  } catch (error) {
    if (error instanceof IdJagError && error.code === 'invalid_request' && error.errorDescription === SUBJECT_TOKEN_INVALID_DESCRIPTION) {
      throw new IdJagError('invalid_grant', SUBJECT_TOKEN_INVALID_DESCRIPTION);
    }
    throw error;
  }
}
