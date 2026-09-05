import {
  authorizeIdJagRedemptionClient, IdJagError, parseIdJagRedemptionParams,
  resolveIdJagGrantScope, verifyIdJagAssertion,
  type IdJagAssertionPayload, type IdJagTrustedIdentityProvider,
} from '@maronn-openid-connect/experimental/id-jag';
import type { TokenClientInfo } from '@maronn-openid-connect/core';
import { decodeJwsUnverified, jwkThumbprint, verifyDpopProof, XaaCryptoError, type JtiStore } from '@xaa/crypto';

/** A 403 the library's IdJagError cannot express (it is always 400). */
export class ResourceAsError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'ResourceAsError';
  }
}

/**
 * An `invalid_grant` from the confirmation binding. The caller sees one answer for
 * every way possession can fail, while the log keeps the PROTOCOL_VIOLATION code the
 * detection pipeline needs: a replayed proof and a mismatched key are the same
 * refusal on the wire and two different findings in the audit trail.
 */
export class ClientBindingError extends IdJagError {
  constructor(
    readonly validationName: 'replayed_dpop_proof' | 'dpop_key_binding_mismatch',
    readonly observation: ClientBindingObservation,
  ) {
    super('invalid_grant', 'The assertion is missing cnf.jkt');
  }
}

/**
 * What the confirmation binding compared, as public values.
 *
 * The wire answer stays one `invalid_grant` for every way possession can fail; this
 * is the other half of that split. Without it a deployment whose two sides disagree
 * about the token endpoint is indistinguishable, in the audit trail, from a stolen
 * key — both read `dpop_key_binding_mismatch` and nothing else.
 *
 * Every member is safe to record: a JWK thumbprint is derived from a public key and
 * an `htu` is a URL. The proof itself is still never logged (RULE-38).
 */
export interface ClientBindingObservation {
  /** Which comparison refused. */
  step: 'assertion_cnf' | 'dpop_header' | 'proof' | 'thumbprint';
  /** `cnf.jkt` from the ID-JAG. */
  expected_jkt: string | null;
  /** The thumbprint of the key the proof carries. */
  presented_jkt: string | null;
  /** The token endpoint this AS builds from `ISSUER`. */
  expected_htu: string;
  /** The `htu` the caller signed into the proof. */
  presented_htu: string | null;
}

/**
 * The two values the binding compares, read from the proof without verifying it.
 *
 * A rejected proof still has to name what it claimed, or `proof` and `thumbprint`
 * are the same line in the log. Nothing read here is trusted for a decision.
 */
async function inspectProof(proof: string | undefined): Promise<{ htu: string | null; jkt: string | null }> {
  if (!proof) return { htu: null, jkt: null };
  try {
    const { header, payload } = decodeJwsUnverified(proof);
    const jwk = (header as { jwk?: unknown }).jwk;
    let jkt: string | null = null;
    try { if (jwk && typeof jwk === 'object') jkt = await jwkThumbprint(jwk as Parameters<typeof jwkThumbprint>[0]); } catch { jkt = null; }
    return { htu: typeof payload.htu === 'string' ? payload.htu : null, jkt };
  } catch {
    return { htu: null, jkt: null };
  }
}

export const REDEEM_STEPS = [
  'authorize_client', 'parse_params', 'verify_assertion', 'bind_cnf',
  'resolve_scope', 'registered_scope', 'isolation', 'revocation', 'issue_token', 'log',
] as const;
export type RedeemStep = (typeof REDEEM_STEPS)[number];

export interface RedeemInput {
  params: Record<string, string>;
  client: TokenClientInfo;
  issuer: string;
  identityProviders: IdJagTrustedIdentityProvider[];
  registeredScopes: readonly string[];
  jtiStore: JtiStore;
  dpopHeader: string | undefined;
  /** Absolute token endpoint URL, from ISSUER — never from the Host header. */
  tokenEndpoint: string;
  /** Finance requires full_isolation; documents leaves this unset. */
  requireIsolationLevel?: string;
  isActorRevoked?(actorUrn: string): Promise<boolean>;
  now?: () => number;
  recordStep?(step: RedeemStep): void;
}

export interface RedeemResult {
  assertion: IdJagAssertionPayload;
  scope: string[];
  jkt: string;
  isolationLevel: string | undefined;
  constraints: Record<string, unknown> | undefined;
  actorUrn: string;
}

/**
 * The redemption half of Cross App Access, written as an explicit sequence rather
 * than the library's one-shot helper: the confirmation binding, the isolation gate
 * and the revocation check all have to sit between library steps (T-RES-06).
 *
 * Nothing here consults the caller's service account, the Cloud Run headers or any
 * `X-Forwarded-*` value. Passing Cloud Run IAM is not evidence about the token
 * (REQ-08-044), so there is no branch that could skip a check.
 */
export async function redeemIdJag(input: RedeemInput): Promise<RedeemResult> {
  const step = (name: RedeemStep) => input.recordStep?.(name);

  step('authorize_client');
  authorizeIdJagRedemptionClient(input.client);

  step('parse_params');
  const parsed = parseIdJagRedemptionParams(input.params);

  step('verify_assertion');
  const assertion = await verifyIdJagAssertion({
    assertion: parsed.assertion,
    issuer: input.issuer,
    clientId: input.client.clientId,
    identityProviders: input.identityProviders,
    ...(input.now ? { now: new Date(input.now()) } : {}),
  });

  step('bind_cnf');
  // verifyIdJagAssertion does not surface `cnf`, `isolation_level` or `constraints`,
  // so the already-verified assertion is decoded again for them. The raw request
  // parameters are never re-read here (DEC-ID-14).
  const raw = decodeJwsUnverified(parsed.assertion).payload;
  const jkt = await bindClientByCnf({
    payload: raw, dpopHeader: input.dpopHeader, tokenEndpoint: input.tokenEndpoint,
    jtiStore: input.jtiStore, ...(input.now ? { now: input.now } : {}),
  });

  step('resolve_scope');
  const scope = resolveIdJagGrantScope(parsed.scope, assertion.scope);

  step('registered_scope');
  // RULE-52: what this AS registered is the ceiling on the damage a leaked ID-JAG
  // signing key could do, so anything outside it is refused here as well.
  const outside = scope.find((value) => !input.registeredScopes.includes(value));
  if (outside !== undefined) throw new IdJagError('invalid_scope', 'The requested scope is not registered for this resource');

  // The isolation gate belongs to finance alone (T-RES-19). The documents pipeline
  // has no such step at all, rather than a step that always says yes.
  const isolationLevel = typeof raw.isolation_level === 'string' ? raw.isolation_level : undefined;
  if (input.requireIsolationLevel !== undefined) {
    step('isolation');
    if (isolationLevel !== input.requireIsolationLevel) throw new ResourceAsError(403, 'insufficient_isolation');
  }

  step('revocation');
  const actorUrn = typeof assertion.act?.sub === 'string' ? assertion.act.sub : '';
  if (actorUrn === '') throw new IdJagError('invalid_grant', 'The assertion carries no actor');
  if (await input.isActorRevoked?.(actorUrn)) throw new IdJagError('invalid_grant', 'The actor is no longer active');

  return {
    assertion,
    scope,
    jkt,
    isolationLevel,
    constraints: raw.constraints && typeof raw.constraints === 'object' ? raw.constraints as Record<string, unknown> : undefined,
    actorUrn,
  };
}

/**
 * DEC-ID-14 / REQ-05-085. Client authentication is proof of possession of the key
 * the ID-JAG was bound to, not a shared secret. Presence of a DPoP header alone
 * proves nothing, so the thumbprints are compared byte for byte.
 */
export async function bindClientByCnf(options: {
  payload: Record<string, unknown>;
  dpopHeader: string | undefined;
  tokenEndpoint: string;
  jtiStore: JtiStore;
  now?: () => number;
}): Promise<string> {
  const cnf = options.payload.cnf;
  const expected = cnf && typeof cnf === 'object' && typeof (cnf as Record<string, unknown>).jkt === 'string'
    ? (cnf as Record<string, unknown>).jkt as string
    : null;
  const presented = await inspectProof(options.dpopHeader);
  const observe = (step: ClientBindingObservation['step']): ClientBindingObservation => ({
    step, expected_jkt: expected, presented_jkt: presented.jkt,
    expected_htu: options.tokenEndpoint, presented_htu: presented.htu,
  });

  if (expected === null) throw new ClientBindingError('dpop_key_binding_mismatch', observe('assertion_cnf'));
  if (!options.dpopHeader) throw new ClientBindingError('dpop_key_binding_mismatch', observe('dpop_header'));
  try {
    const verified = await verifyDpopProof(options.dpopHeader, {
      method: 'POST', url: options.tokenEndpoint, jtiStore: options.jtiStore,
      iatWindowSeconds: 60, ...(options.now ? { now: options.now } : {}),
    });
    if (await jwkThumbprint(verified.publicJwk) !== expected) {
      throw new ClientBindingError('dpop_key_binding_mismatch', observe('thumbprint'));
    }
    return expected;
  } catch (error) {
    if (error instanceof IdJagError) throw error;
    // Any failure to establish possession of the bound key is one answer: a
    // malformed proof, a replayed jti and a mismatched thumbprint are all
    // indistinguishable to the caller. Only the recorded validation_name and the
    // observation above differ.
    const replayed = error instanceof XaaCryptoError && error.code === 'replayed_dpop_proof';
    throw new ClientBindingError(replayed ? 'replayed_dpop_proof' : 'dpop_key_binding_mismatch', observe('proof'));
  }
}
