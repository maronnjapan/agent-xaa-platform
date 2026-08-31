import {
  buildAccessTokenAudience, buildAccessTokenPayload, createJwtAccessTokenIssuer,
  type TokenClientInfo,
} from '@maronn-openid-connect/core';
import { IdJagError } from '@maronn-openid-connect/experimental/id-jag';
import { TOOL_IDS } from '@xaa/contracts';
import {
  inspectAssertion, logIdJagRedemption, redeemIdJag, ResourceAsError,
  type IdJagRedemptionLog, type RedeemStep,
} from '@xaa/resource-guard';
import type { Context } from 'hono';

export interface RedeemDeps {
  issuer: string;
  accessTokenExpiresIn: number;
  registeredScopes: readonly string[];
  requireIsolationLevel?: string;
  identityProviders: () => Promise<Parameters<typeof redeemIdJag>[0]['identityProviders']>;
  jtiStore: Parameters<typeof redeemIdJag>[0]['jtiStore'];
  isActorRevoked?: (actorUrn: string) => Promise<boolean>;
  signingKey: { privateKey: CryptoKey; kid: string };
  storeAccessToken?: (token: string, info: Record<string, unknown>) => Promise<void>;
  logger: Parameters<typeof logIdJagRedemption>[0];
  now?: () => number;
  recordStep?: (step: RedeemStep) => void;
}

export const REDEEM_DEPS_KEY = 'xaaRedeemDeps';

/**
 * The configuration travels on the request context, not in a module-scoped variable:
 * an integration run holds both Resource AS in one process, and a shared singleton
 * would let whichever started last answer for both.
 */
export function redeemDepsMiddleware(deps: RedeemDeps) {
  return async (context: Context, next: () => Promise<void>) => {
    context.set(REDEEM_DEPS_KEY, deps);
    await next();
  };
}

/**
 * The jwt-bearer branch of the Resource AS token endpoint.
 *
 * RFC 6749 §5.2 shapes the failures: a missing assertion is 400 invalid_request and
 * a rejected one is 400 invalid_grant. The 401 with WWW-Authenticate that
 * REQ-08-044 asks for belongs to the Resource API, not here, so no branch in this
 * endpoint returns 401.
 */
export async function redeemHandler(context: Context, params: Record<string, string>, client: TokenClientInfo): Promise<Response> {
  const deps = context.get(REDEEM_DEPS_KEY) as RedeemDeps | undefined;
  if (!deps) throw new Error('redeem is not configured');
  const inspected = inspectAssertion(params.assertion);
  const entry: IdJagRedemptionLog = {
    ...inspected, scope: params.scope ?? null, cnf_jkt_match: null, token_issued: false,
    authorization_decision: 'deny:unknown', validation_name: null,
  };
  const logContext = { request_id: '', trace_id: context.req.header('X-Cloud-Trace-Context')?.split('/')[0] ?? '', agent_id: null, human_subject: null };

  try {
    const result = await redeemIdJag({
      params, client, issuer: deps.issuer,
      identityProviders: await deps.identityProviders(),
      registeredScopes: deps.registeredScopes,
      jtiStore: deps.jtiStore,
      dpopHeader: context.req.header('DPoP'),
      tokenEndpoint: `${deps.issuer}/token`,
      ...(deps.requireIsolationLevel ? { requireIsolationLevel: deps.requireIsolationLevel } : {}),
      ...(deps.isActorRevoked ? { isActorRevoked: deps.isActorRevoked } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.recordStep ? { recordStep: deps.recordStep } : {}),
    });
    entry.cnf_jkt_match = true;
    entry.scope = result.scope.join(' ');

    const issuedAt = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const audience = buildAccessTokenAudience({
      userInfoEndpoint: `${deps.issuer}/userinfo`,
      requested: Array.isArray(result.assertion.resource) ? result.assertion.resource : result.assertion.resource ? [result.assertion.resource] : undefined,
      issuer: deps.issuer,
    });
    const payload = {
      ...buildAccessTokenPayload({
        issuer: deps.issuer, subject: result.assertion.sub, clientId: client.clientId,
        scope: result.scope, audience, expiresIn: deps.accessTokenExpiresIn, issuedAt,
      }),
      act: result.assertion.act,
      cnf: { jkt: result.jkt },
      ...(result.isolationLevel ? { isolation_level: result.isolationLevel } : {}),
      ...(narrowConstraints(result.constraints) ? { xaa_constraints: narrowConstraints(result.constraints) } : {}),
    };
    const accessToken = await createJwtAccessTokenIssuer().issue({
      payload, privateKey: deps.signingKey.privateKey, keyId: deps.signingKey.kid,
    });
    await deps.storeAccessToken?.(accessToken, {
      sub: result.assertion.sub, clientId: client.clientId, scope: result.scope,
      expiresAt: issuedAt + deps.accessTokenExpiresIn, act: result.assertion.act,
      cnf_jkt: result.jkt, idpIssuer: result.assertion.iss, idJagJti: result.assertion.jti,
    });

    entry.token_issued = true;
    entry.authorization_decision = 'allow';
    context.header('Cache-Control', 'no-store');
    context.header('Pragma', 'no-cache');
    // RFC 9449 §5: a key-bound token is presented with the DPoP scheme. No refresh
    // token and no ID Token: re-presenting the still-valid ID-JAG replaces both.
    return context.json({
      access_token: accessToken,
      token_type: 'DPoP',
      expires_in: deps.accessTokenExpiresIn,
      scope: result.scope.join(' '),
    });
  } catch (error) {
    const mapped = toError(error);
    entry.authorization_decision = `deny:${mapped.body.error}`;
    entry.validation_name = mapped.validationName;
    if (mapped.body.error === 'invalid_grant') entry.cnf_jkt_match = entry.cnf_jkt_match ?? false;
    context.header('Cache-Control', 'no-store');
    context.header('Pragma', 'no-cache');
    return context.json(mapped.body, mapped.status);
  } finally {
    logIdJagRedemption(deps.logger, logContext, entry);
  }
}

/**
 * Only the approval tool's own constraint travels into the Access Token; every other
 * key in the assertion's `constraints` map belongs to a different tool and is
 * dropped here rather than handed to the Resource API.
 */
const APPROVE_TOOL_ID = TOOL_IDS[6];

function narrowConstraints(constraints: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const entry = constraints?.[APPROVE_TOOL_ID];
  return entry && typeof entry === 'object' ? entry as Record<string, unknown> : undefined;
}

function toError(error: unknown): { status: 400 | 403; body: { error: string; error_description: string }; validationName: string } {
  if (error instanceof ResourceAsError) {
    return { status: 403, body: { error: error.code, error_description: 'The agent is not sufficiently isolated' }, validationName: error.code };
  }
  if (error instanceof IdJagError) {
    const replayed = error.errorDescription.includes('cnf.jkt');
    return {
      status: 400, body: { error: error.code, error_description: error.errorDescription },
      validationName: replayed ? 'dpop_key_binding_mismatch' : error.code,
    };
  }
  return { status: 400, body: { error: 'invalid_request', error_description: 'The request could not be processed' }, validationName: 'invalid_request' };
}
