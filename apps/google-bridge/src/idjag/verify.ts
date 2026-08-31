import { parseIdJagRedemptionParams, verifyIdJagAssertion } from '@maronn-openid-connect/experimental/id-jag';
import { decodeJwsUnverified } from '@xaa/crypto';
import { JWT_TYP, PLATFORM_CLIENT_ID } from '@xaa/contracts';
import { BridgeError } from '../errors.js';
import type { VerifiedIdJag } from '../dpop/cnf-binding.js';

export interface JwkSet { keys: Array<Record<string, unknown>> }

/**
 * Verifies the ID-JAG the agent presents, using the library rather than by hand.
 *
 * RULE-45: signature and claim checks come from maronn's own redeem helpers. Writing a
 * second implementation here would mean two verifiers that must agree forever, and the
 * one in the library is the one the Agent OP's issuance was written against.
 *
 * The key set comes from configuration. The assertion's own `jku`, `x5u` and `jwk`
 * headers are never read: an attacker who can choose where the verifier fetches keys
 * can sign anything.
 */
export async function verifyBridgeIdJag(input: {
  params: Record<string, string>;
  jwks: JwkSet;
  sharedIssuer: string;
  expectedAudience: string;
}): Promise<VerifiedIdJag> {
  const parsed = parseIdJagRedemptionParams(input.params as never);
  const assertion = (parsed as { assertion: string }).assertion;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    const decoded = decodeJwsUnverified(assertion);
    header = decoded.header;
    payload = decoded.payload;
  } catch {
    throw new BridgeError('invalid_grant', 400);
  }
  for (const dangerous of ['jku', 'x5u', 'jwk']) {
    if (dangerous in header) throw new BridgeError('invalid_grant', 400);
  }
  // Checked here as well as in the library (DEC-ID-18). Under one issuer and one key
  // set, `typ` is the only thing separating an ID-JAG from an Access Token.
  if (header.typ !== JWT_TYP.ID_JAG) throw new BridgeError('invalid_grant', 400);

  try {
    await verifyIdJagAssertion({
      assertion,
      // The `issuer` here is the audience the assertion must name: this Bridge
      // (DEC-ID-05). The trusted list is one entry — the shared IdP — so a key from
      // anywhere else cannot satisfy it.
      issuer: input.expectedAudience,
      clientId: PLATFORM_CLIENT_ID,
      identityProviders: [{ issuer: input.sharedIssuer, jwks: input.jwks as never }],
    });
  } catch {
    // One error code for every reason. Distinguishing "bad signature" from "unknown
    // issuer" tells a prober which half of their forgery to fix.
    throw new BridgeError('invalid_grant', 400);
  }

  if (payload.client_id !== PLATFORM_CLIENT_ID) throw new BridgeError('invalid_grant', 400);
  const cnf = payload.cnf as { jkt?: unknown } | undefined;
  const act = payload.act as { sub?: unknown } | undefined;

  return {
    sub: String(payload.sub ?? ''),
    actSub: typeof act?.sub === 'string' ? act.sub : '',
    aud: String(payload.aud ?? ''),
    scope: typeof payload.scope === 'string' ? payload.scope : (payload.scope as string[] | undefined)?.join(' ') ?? '',
    resource: String(payload.resource ?? ''),
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
    cnfJkt: typeof cnf?.jkt === 'string' ? cnf.jkt : '',
    kid: String(header.kid ?? ''),
    issuer: String(payload.iss ?? ''),
  };
}
