// XAA-PATCH:REQ-05-085 begin
import { redeemHandler } from '../../idjag/redeem.js';
// XAA-PATCH:REQ-05-085 end
import { Hono } from 'hono';
import {
  validateGrantTypeSupported,
  resolveAuthenticatedTokenClient,
  validateClientGrantType,
  resolveAuthorizationCode,
  validateAuthorizationCodeUnused,
  validateAuthorizationCodeClient,
  validateAuthorizationCodeExpiration,
  validateAuthorizationCodeRedirectUri,
  verifyAuthorizationCodePkce,
  consumeAuthorizationCode,
  buildValidatedAuthorizationCodeRequest,
  resolveRefreshToken,
  validateRefreshTokenUnused,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenIdleTimeout,
  validateRefreshTokenScope,
  validateRefreshTokenSession,
  clientAllowsRefreshTokenGrant,
  buildValidatedRefreshTokenRequest,
  buildAccessTokenPayload,
  computeAtHash,
  resolveAcrAmr,
  buildIdTokenPayload,
  generateIdToken,
  generateRandomString,
  buildAccessTokenAudience,
  extractClientCredentials,
  validateClientAuthMethod,
  verifyClientSecret,
  createJwtAccessTokenIssuer,
  createOpaqueAccessTokenIssuer,
  selectSigningKeyByAlg,
  TokenError,
  TokenErrorCode,
  type AccessTokenIssuer,
  type AcrResolver,
  type SigningKey,
  type TokenRequestParams,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import {
  tokenClientResolver as defaultTokenClientResolver,
  authorizationCodeResolver as defaultAuthorizationCodeResolver,
  refreshTokenResolver as defaultRefreshTokenResolver,
  authenticationSessionResolver as defaultAuthenticationSessionResolver,
} from '../resolvers.js';
import {
  accessTokenStore as defaultAccessTokenStore,
  authCodeStore as defaultAuthCodeStore,
  refreshTokenStore as defaultRefreshTokenStore,
} from '../store.js';
import type { RegisteredClient } from '../config.js';
import {
  IdJagError,
  JWT_BEARER_GRANT_TYPE,
  ID_JAG_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ID_TOKEN,
  matchesIdJagIssuanceRequest,
  processIdJagIssuanceRequest,
  processIdJagRedemptionRequest,
  resolveIdJagActor,
  type IdJagAccessTokenInfo,
  type IdJagActorTokenResolver,
  type IdJagTrustedIdentityProvider,
} from '@maronn-openid-connect/experimental/id-jag';
import type { JwkSet } from '@maronn-openid-connect/core';

/**
 * EXPERIMENTAL — Cross-App Access (XAA) / ID-JAG settings
 * (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Issuing side (this OP as the IdP, draft §4.3):
 * - allowedAudiences: resource authorization server issuers this IdP may issue
 *   an ID-JAG for. Empty by default (fail safe): every issuance request is
 *   rejected with invalid_target until you list the peer AS issuers here.
 *   Adding an entry grants that cross-app connection on behalf of every user —
 *   there is no per-user consent screen in this flow.
 * - idJagLifetimeSeconds: ID-JAG lifetime. Keep it short (draft example: 300);
 *   clients are expected to request a fresh one instead of holding it.
 * - allowedScopes: optional cap on the scopes an ID-JAG may carry. undefined
 *   passes the requested scopes through (the resource AS applies its own
 *   policy again on redemption).
 * - allowRefreshTokenSubjects: whether a refresh token this OP issued may stand
 *   in for the ID Token as the subject_token (draft §4.3 MAY), so a client can
 *   request a fresh ID-JAG after its ID Token expired without a new SSO round
 *   trip. Validated exactly like the standard refresh_token grant (rotation
 *   reuse revokes the token family; online tokens require the login session to
 *   be alive); the refresh token is NOT consumed. Grants without the openid
 *   scope are refused — their refresh token replaces no identity assertion.
 * - allowActorTokens: whether an actor_token (identifying who acts on the
 *   subject's behalf) is accepted and recorded as the ID-JAG's act claim
 *   (RFC 8693 §4.1). The draft defines no normative actor processing (§9.7
 *   sketches extensions), so this is an opt-in extension and defaults to
 *   false — an actor_token is rejected until you flip it, whatever else is
 *   configured. Every token type identifier RFC 8693 §3 defines is accepted
 *   the same way; the type alone decides nothing.
 * - actorTokenResolver: validates the actor_token's CONTENT (signature,
 *   revocation, whose token it is) — for every accepted type, this OP's own
 *   ID Tokens included. The library only checks the request structure and the
 *   shape of what you return. Return the act value ({ sub, act? }) for a valid
 *   token, null for an invalid one (answered with a fixed invalid_request), or
 *   throw IdJagError to pick the response yourself. The default below handles
 *   ID Tokens this OP issued to the authenticated client; extend or replace it
 *   to cover the other types. Clearing it rejects every actor_token.
 *
 * Consuming side (this OP as the resource authorization server, draft §4.4):
 * - trustedIdentityProviders: the IdPs whose ID-JAGs are accepted on the
 *   jwt-bearer grant. Empty by default (fail safe). Keys come from the inline
 *   `jwks` when present, otherwise from `jwksUri` (fetched and cached below).
 *   Never derive the key source from the assertion itself.
 */
const defaultIdJagActorTokenResolver: IdJagActorTokenResolver = async ({
  actorToken,
  actorTokenType,
  clientId,
  issuer,
  jwks,
}) =>
  actorTokenType === TOKEN_TYPE_ID_TOKEN
    ? resolveIdJagActor({ actorToken, issuer, clientId, jwks })
    : null;

export const idJagConfig = {
  allowedAudiences: [] as string[],
  idJagLifetimeSeconds: 300,
  allowedScopes: undefined as string[] | undefined,
  allowRefreshTokenSubjects: true,
  allowActorTokens: false,
  actorTokenResolver: defaultIdJagActorTokenResolver as IdJagActorTokenResolver | undefined,
  trustedIdentityProviders: [] as Array<{ issuer: string; jwksUri?: string; jwks?: JwkSet }>,
};

/**
 * EXPERIMENTAL — jwks_uri cache for trusted identity providers.
 *
 * A fetched JWKS is reused for 300 seconds, so a signing-key rotation at the
 * IdP can take up to that long to be picked up (a verification that fails
 * within the window is answered as an untrusted assertion). The fetch target
 * comes exclusively from the static idJagConfig above — never from request or
 * assertion content — which is what keeps this endpoint SSRF-free.
 */
const idJagJwksCache = new Map<string, { jwks: JwkSet; expiresAt: number }>();
const ID_JAG_JWKS_CACHE_TTL_MS = 300_000;

async function resolveTrustedIdentityProviders(): Promise<IdJagTrustedIdentityProvider[]> {
  const resolved: IdJagTrustedIdentityProvider[] = [];
  for (const entry of idJagConfig.trustedIdentityProviders) {
    if (entry.jwks !== undefined) {
      resolved.push({ issuer: entry.issuer, jwks: entry.jwks });
      continue;
    }
    if (entry.jwksUri === undefined) {
      // An entry with neither jwks nor jwksUri can never verify anything; skip
      // it so the assertion is answered with the fixed untrusted description.
      continue;
    }
    const cached = idJagJwksCache.get(entry.jwksUri);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      resolved.push({ issuer: entry.issuer, jwks: cached.jwks });
      continue;
    }
    // A failed fetch propagates: the generic catch turns it into server_error,
    // which is honest — the assertion was never evaluated, so invalid_grant
    // would wrongly blame the client for an outage on this side.
    const response = await fetch(entry.jwksUri);
    if (!response.ok) {
      throw new Error(`Fetching the JWKS of trusted IdP ${entry.issuer} failed with status ${response.status}`);
    }
    const jwks = (await response.json()) as JwkSet;
    idJagJwksCache.set(entry.jwksUri, { jwks, expiresAt: Date.now() + ID_JAG_JWKS_CACHE_TTL_MS });
    resolved.push({ issuer: entry.issuer, jwks });
  }
  return resolved;
}

export const tokenApp = new Hono<{ Variables: Record<string, any> }>();

/**
 * Narrows raw body params to the typed TokenRequestParams.
 * Returns false when the required grant_type field is absent.
 */
function isTokenRequestParams(
  params: unknown,
): params is TokenRequestParams {
  if (typeof params !== 'object' || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p['grant_type'] === 'string';
}

/**
 * Returns true when the Content-Type names application/x-www-form-urlencoded.
 * RFC 6749 §4.1.3 / Appendix B / OIDC Core 1.0 §3.1.3.1: the Token Request
 * entity-body MUST be application/x-www-form-urlencoded. Media types are
 * case-insensitive (RFC 9110 §8.3.1) and may carry parameters such as
 * "; charset=UTF-8", so we lowercase and strip everything after the first ';'.
 */
function isFormUrlEncoded(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/x-www-form-urlencoded';
}

/**
 * Token Endpoint
 * OIDC Core 1.0 Section 3.1.3
 */
tokenApp.post('/', async (c) => {
  // RFC 6749 §4.1.3 / OIDC Core 1.0 §3.1.3.1: reject any body that is not
  // application/x-www-form-urlencoded (e.g. multipart/form-data, application/json)
  // before parsing so a non-form payload is never consumed as token parameters.
  const contentType = c.req.header('Content-Type') ?? '';
  if (!isFormUrlEncoded(contentType)) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Token requests must use application/x-www-form-urlencoded' }, 400);
  }

  // RFC 6749 §3.2: token endpoint request parameters MUST NOT be repeated.
  // Read the raw form body so URLSearchParams iteration exposes duplicate keys
  // instead of letting parseBody silently keep only the last value.
  const rawBody = await c.req.text();
  const searchParams = new URLSearchParams(rawBody);
  const rawParams: Record<string, string> = {};
  const seen = new Set<string>();
  let duplicateKey: string | undefined;
  for (const [key, value] of searchParams) {
    if (seen.has(key)) {
      duplicateKey = key;
      break;
    }
    seen.add(key);
    rawParams[key] = value;
  }
  const authorization = c.req.header('Authorization') ?? '';

  if (duplicateKey !== undefined) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: `Parameter "${duplicateKey}" must not be repeated` }, 400);
  }

  if (!isTokenRequestParams(rawParams)) {
    // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'invalid_request', error_description: 'Missing required parameter: grant_type' }, 400);
  }

  const params = rawParams;
// XAA-PATCH:REQ-05-085 begin
  // DEC-ID-21: only Agent OP issues an ID-JAG, so the exchange grant is refused
  // here before anything else runs and this AS's signing key stays an Access Token
  // key (RULE-48).
  if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'unsupported_grant_type', error_description: 'This authorization server does not issue grants' }, 400);
  }

  // DEC-ID-14 / REQ-05-085: for the jwt-bearer grant, client authentication is
  // possession of the key the ID-JAG was bound to, not a shared secret. The
  // generated client_secret pipeline below is bypassed for this grant alone, and
  // redeemHandler performs the cnf.jkt-to-proof comparison instead. Reaching the
  // route through Cloud Run IAM grants nothing (REQ-08-044).
  if (params.grant_type === JWT_BEARER_GRANT_TYPE) {
    const redemptionResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const redemptionClient = await redemptionResolver.findClient(typeof params.client_id === 'string' ? params.client_id : '');
    if (redemptionClient === null) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401);
    }
    return redeemHandler(c, params, redemptionClient);
  }
// XAA-PATCH:REQ-05-085 end

  try {
    const tokenClientResolver = c.get('tokenClientResolver') ?? defaultTokenClientResolver;
    const authorizationCodeResolver =
      c.get('authCodeResolver') ?? defaultAuthorizationCodeResolver;
    const refreshTokenResolver =
      c.get('refreshTokenResolver') ?? defaultRefreshTokenResolver;
    // online refresh token の束縛先セッションを sessionId から引く。差し替えると
    // 「セッションが生きているか」の判定そのものを差し替えられる。
    const authenticationSessionResolver =
      c.get('authenticationSessionResolver') ?? defaultAuthenticationSessionResolver;
    const authCodeStore = c.get('authCodeStore') ?? defaultAuthCodeStore;
    const accessTokenStore = c.get('accessTokenStore') ?? defaultAccessTokenStore;
    const refreshTokenStore = c.get('refreshTokenStore') ?? defaultRefreshTokenStore;

    // --- Client authentication pipeline -------------------------------------
    // OAuth 2.1 §2.3 / OIDC Core 1.0 §9: client_secret_basic / client_secret_post.
    // Each step below is an independent core function, called in the same order
    // as core's authenticateClient(). Replace verifyClientSecret with your own
    // assertion check (e.g. private_key_jwt) without touching the rest.

    // Read the presented credentials and which method was actually used.
    const presentedCredentials = extractClientCredentials({
      params,
      authorizationHeader: authorization,
    });

    // RFC 6749 §5.2: the presented client_id must resolve to a registered client.
    const tokenClient = await resolveAuthenticatedTokenClient(
      presentedCredentials.clientId,
      tokenClientResolver,
    );

    // OIDC Core 1.0 §9: the method used must match the registered
    // token_endpoint_auth_method (blocks auth method downgrade / public-client mixups).
    validateClientAuthMethod(tokenClient, presentedCredentials);

    // OAuth 2.1 §7.4.1: constant-time client_secret comparison.
    await verifyClientSecret(tokenClient, presentedCredentials.clientSecret);

    const authenticatedClientId = presentedCredentials.clientId;

    // --- EXPERIMENTAL: ID-JAG issuance (Cross-App Access, draft §4.3) ------
    // A token-exchange request whose requested_token_type is the ID-JAG URN.
    // Dispatched right after client authentication and BEFORE the plain
    // token-exchange branch (same grant_type URN) and core's
    // validateGrantTypeSupported. The subject_token must be an ID Token this OP
    // issued to the authenticated client; the result is a signed grant JWT for
    // the resource authorization server named by `audience` — not an access
    // token (the response carries token_type N_A).
    //
    // Backed by @maronn-openid-connect/experimental, whose API is NOT stable: it may change
    // in a breaking way between releases. The underlying specification is an
    // IETF draft (-04) and may itself change. Do not build production code on
    // this without pinning versions.
    if (matchesIdJagIssuanceRequest(params)) {
      const idJagIssuanceConfig = c.get('config');
      // The ID-JAG is signed with a registered RS256 key so the peer AS can
      // verify it against this OP's JWKS endpoint (same key-selection contract
      // as JARM: RS256 is pinned, the active key may be a different alg).
      const idJagSigningKeys = (c.get('signingKeys') as SigningKey[] | undefined) ?? [];
      let idJagSigningKey: SigningKey;
      try {
        idJagSigningKey = selectSigningKeyByAlg(idJagSigningKeys, 'RS256');
      } catch {
        c.header('Cache-Control', 'no-store');
        c.header('Pragma', 'no-cache');
        return c.json(
          { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
          500,
        );
      }
      // The subject_token is verified against the same JWKS that id_token_hint
      // uses (the OP's own ID Token signing keys) — draft §4.3.3 requires the
      // assertion's audience to be the authenticated client, which
      // processIdJagIssuanceRequest checks.
      const idJagJwks = await c.get('jwksProvider')();

      const idJagIssuanceResponse = await processIdJagIssuanceRequest({
        params,
        client: tokenClient,
        issuer: idJagIssuanceConfig.issuer,
        jwks: idJagJwks,
        signingKey: idJagSigningKey,
        allowedAudiences: idJagConfig.allowedAudiences,
        allowedScopes: idJagConfig.allowedScopes,
        lifetimeSeconds: idJagConfig.idJagLifetimeSeconds,
        // Extension (draft §9.7): when enabled, an actor_token is recorded as
        // the ID-JAG's act claim. Every accepted token type goes through the
        // same resolver, which owns the content validation.
        allowActorTokens: idJagConfig.allowActorTokens,
        ...(idJagConfig.actorTokenResolver === undefined
          ? {}
          : { actorTokenResolver: idJagConfig.actorTokenResolver }),
        ...(idJagConfig.allowRefreshTokenSubjects
          ? { refreshTokenResolver, authenticationSessionResolver }
          : {}),
      });

      // RFC 6749 §5.1: token responses MUST NOT be cached. The ID-JAG itself is
      // not persisted — it is a self-contained signed grant the peer AS
      // verifies by signature and exp.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(idJagIssuanceResponse);
    }

    // Generated without --enable token-exchange: the exchange grant exists here
    // only to issue ID-JAGs, so any other requested_token_type is answered with
    // a pointer instead of falling through to unsupported_grant_type (discovery
    // does advertise the exchange grant in this build).
    if (params.grant_type === TOKEN_EXCHANGE_GRANT_TYPE) {
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'invalid_request',
          error_description: `This authorization server only supports requested_token_type ${ID_JAG_TOKEN_TYPE} for token exchange`,
        },
        400,
      );
    }

    // --- EXPERIMENTAL: ID-JAG redemption (Cross-App Access, draft §4.4) ----
    // The jwt-bearer grant (RFC 7523 §2.1). The assertion must be an ID-JAG
    // (typ oauth-id-jag+jwt) issued by one of idJagConfig.trustedIdentityProviders
    // for THIS issuer and for the authenticated client. This OP then issues its
    // own access token — the IdP never mints tokens for this AS.
    //
    // No ID Token is issued (this is not an OIDC authentication flow: the
    // openid scope only grants UserInfo access) and no refresh token is issued
    // (draft §4.4.3 SHOULD NOT — re-presenting the still-valid ID-JAG replaces
    // the refresh token).
    if (params.grant_type === JWT_BEARER_GRANT_TYPE) {
      const idJagRedemptionConfig = c.get('config');
      const idJagIdentityProviders = await resolveTrustedIdentityProviders();

      const idJagGrant = await processIdJagRedemptionRequest({
        params,
        client: tokenClient,
        issuer: idJagRedemptionConfig.issuer,
        identityProviders: idJagIdentityProviders,
        configuredExpiresIn: idJagRedemptionConfig.accessTokenExpiresIn,
      });

      // config / privateKey / keyId are bound further down for the standard
      // grants. This branch reads them on its own so the generated output is
      // unchanged when the feature is off; it returns, so nothing runs twice.
      const idJagTokenIssuer: AccessTokenIssuer =
        idJagRedemptionConfig.accessTokenFormat === 'opaque'
          ? createOpaqueAccessTokenIssuer()
          : createJwtAccessTokenIssuer();

      // Same aud policy as the standard token route: the UserInfo endpoint
      // stays a permanent member (RFC 9068 §3); the ID-JAG's resource claim
      // (RFC 8707) contributes the requested resources.
      const idJagAudience = buildAccessTokenAudience({
        userInfoEndpoint: `${idJagRedemptionConfig.issuer}/userinfo`,
        requested: idJagGrant.requestedResources,
        issuer: idJagRedemptionConfig.issuer,
      });

      const idJagIssuedAt = Math.floor(Date.now() / 1000);
      const idJagAccessTokenPayload = buildAccessTokenPayload({
        issuer: idJagRedemptionConfig.issuer,
        subject: idJagGrant.subject,
        clientId: idJagGrant.clientId,
        scope: idJagGrant.scope,
        audience: idJagAudience,
        expiresIn: idJagGrant.expiresIn,
        issuedAt: idJagIssuedAt,
      });
      const idJagAccessToken = await idJagTokenIssuer.issue({
        payload: {
          ...idJagAccessTokenPayload,
          // RFC 8693 §4.1: an act claim carried by the ID-JAG is preserved on
          // the issued access token, so downstream services still see WHO acts
          // on the subject's behalf (dropping it would silently turn the
          // delegation into impersonation).
          ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
        },
        privateKey: c.get('privateKey'),
        keyId: c.get('keyId'),
      });

      const idJagAccessTokenMetadata: IdJagAccessTokenInfo = {
        // draft §4.4.1: the ID-JAG's sub is used as the local subject directly
        // (subject resolution by identical sub; JIT provisioning is out of scope).
        sub: idJagGrant.subject,
        clientId: idJagGrant.clientId,
        scope: idJagGrant.scope,
        expiresAt: idJagIssuedAt + idJagGrant.expiresIn,
        // Each redemption is its own grant: revoking one issued token must not
        // affect tokens from other redemptions of the same (re-presentable)
        // ID-JAG, so the payload's own jti doubles as the grant id.
        grantId: idJagAccessTokenPayload.jti,
        iat: idJagIssuedAt,
        nbf: idJagIssuedAt,
        audience: idJagAudience,
        issuer: idJagRedemptionConfig.issuer,
        jti: idJagAccessTokenPayload.jti,
        // The actor record is persisted too, so opaque-token introspection and
        // store-based tooling can surface it just like the JWT claim.
        ...(idJagGrant.actor === undefined ? {} : { act: idJagGrant.actor }),
      };
      await accessTokenStore.set(idJagAccessToken, idJagAccessTokenMetadata);

      // RFC 6749 §5.1: token responses MUST NOT be cached.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        access_token: idJagAccessToken,
        token_type: 'Bearer' as const,
        expires_in: idJagGrant.expiresIn,
        scope: idJagGrant.scope.join(' '),
      });
    }

    // --- Token request validation pipeline --------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's validateTokenRequest(). Delete a call to drop that validation,
    // or insert your own logic between steps.

    // RFC 6749 §5.2: is the grant_type offered by this OP at all?
    // (defaults to ['authorization_code', 'refresh_token'])
    const grantType = validateGrantTypeSupported(params.grant_type);

    // RFC 6749 §5.2: per-client grant_type authorization (unauthorized_client).
    validateClientGrantType(tokenClient, grantType);

    // Grant-specific validation. Each security rule is a separate core call so
    // it can be removed, replaced, or surrounded with experiment-specific logic.
    let validatedRequest: ValidatedTokenRequest;
    if (grantType === 'refresh_token') {
      // Resolve the presented refresh token and retain its stored grant context.
      const { refreshTokenInfo } = await resolveRefreshToken(
        params,
        refreshTokenResolver,
      );

      // OAuth 2.1 §4.3.1: reject rotation reuse and revoke the token family.
      await validateRefreshTokenUnused(refreshTokenInfo, refreshTokenResolver);

      // Bind the refresh token to the authenticated client.
      validateRefreshTokenClient(refreshTokenInfo, authenticatedClientId);

      // Absolute lifetime: expiresAt <= now is expired.
      validateRefreshTokenExpiration(refreshTokenInfo);

      // Optional inactivity policy. Replace undefined with your timeout in seconds
      // to enable it, or remove this step if your experiment has no idle lifetime.
      validateRefreshTokenIdleTimeout(refreshTokenInfo, undefined);

      // online refresh token（sessionId を持つ RT）は、束縛先のログインセッションが
      // 生きている間だけ使える。ログアウト・別ユーザーでの再ログインでセッションが
      // 消えれば invalid_grant になる。offline_access が付与された RT は sessionId を
      // 持たないため、このステップを素通りしてログアウト後も使い続けられる。
      await validateRefreshTokenSession(refreshTokenInfo, authenticationSessionResolver);

      // RFC 6749 §6: requested scope may only narrow the original grant.
      const effectiveScope = validateRefreshTokenScope(
        params.scope,
        refreshTokenInfo.scope,
      );

      validatedRequest = buildValidatedRefreshTokenRequest(
        refreshTokenInfo,
        authenticatedClientId,
        effectiveScope,
      );
    } else {
      // Resolve the presented authorization code and retain the non-optional code.
      const { code, authorizationCode } = await resolveAuthorizationCode(
        params,
        authorizationCodeResolver,
      );

      // OAuth 2.1 §4.1.2: reject reuse and revoke tokens from the compromised grant.
      await validateAuthorizationCodeUnused(
        authorizationCode,
        authorizationCodeResolver,
      );

      // Bind the authorization code to the authenticated client and its lifetime.
      validateAuthorizationCodeClient(authorizationCode, authenticatedClientId);
      validateAuthorizationCodeExpiration(authorizationCode);

      // OIDC Core 1.0 §3.1.3.2: bind the token request redirect_uri.
      validateAuthorizationCodeRedirectUri(
        authorizationCode,
        params.redirect_uri,
      );

      // RFC 7636: validate the S256 verifier when the code carries a PKCE binding.
      const codeVerified = await verifyAuthorizationCodePkce(
        authorizationCode,
        params.code_verifier,
      );

      // Mark used (do not physically delete) so a later replay remains detectable.
      await consumeAuthorizationCode(code, authorizationCodeResolver);

      validatedRequest = buildValidatedAuthorizationCodeRequest(
        code,
        authorizationCode,
        authenticatedClientId,
        codeVerified,
      );
    }


    const config = c.get('config');
    const privateKey = c.get('privateKey');
    const keyId = c.get('keyId');

    // T-022: pick an ID Token signing key whose alg matches the client's
    // id_token_signed_response_alg (OIDC Dynamic Client Registration §2).
    // - 未指定クライアントは OIDC 仕様デフォルトの RS256 で扱う。
    // - alg に合う鍵が登録されていなければサーバ設定エラー (server_error)。
    const idTokenSigningKeys = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
    const fallbackIdKey: SigningKey | undefined =
      c.get('idTokenPrivateKey') !== undefined
        ? {
            privateKey: c.get('idTokenPrivateKey'),
            publicJwk: c.get('idTokenPublicJwk'),
            keyId: c.get('idTokenKeyId') ?? keyId,
          }
        : undefined;
    const registeredClient = (await tokenClientResolver.findClient(authenticatedClientId)) as
      | RegisteredClient
      | null;
    const requestedIdTokenAlg = registeredClient?.idTokenSignedResponseAlg;
    let selectedIdTokenKey: SigningKey;
    if (idTokenSigningKeys.length > 0) {
      try {
        selectedIdTokenKey = selectSigningKeyByAlg(idTokenSigningKeys, requestedIdTokenAlg);
      } catch {
        return c.json(
          {
            error: 'server_error',
            error_description: `No ID Token signing key registered for alg "${requestedIdTokenAlg ?? 'RS256'}"`,
          },
          500,
        );
      }
    } else if (fallbackIdKey) {
      selectedIdTokenKey = fallbackIdKey;
    } else {
      return c.json({ error: 'server_error', error_description: 'No ID Token signing key registered' }, 500);
    }
    const idTokenPrivateKey = selectedIdTokenKey.privateKey;
    const idTokenKeyId = selectedIdTokenKey.keyId;

    let subject: string;
    let authTime: number | undefined;
    let nonce: string | undefined;

    if (validatedRequest.grantType === 'authorization_code') {
      const authCode = await authCodeStore.get(validatedRequest.code);
      if (!authCode?.subject || !authCode.authTime) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'Authorization code missing required subject context',
        );
      }
      subject = authCode.subject;
      authTime = authCode.authTime;
      nonce = validatedRequest.nonce;
    } else {
      // refresh_token grant
      // OIDC Core 1.0 §12.2: the re-issued ID Token retains iss/sub/aud/exp/iat/
      // auth_time/azp/acr/amr — nonce is NOT in that list. nonce binds an
      // Authentication Request to its ID Token (§2); a refresh has no such request,
      // so carrying the old nonce adds no replay protection. Major OPs (Google,
      // Auth0) omit it on refresh, so we omit it here by default. auth_time is
      // still preserved per §12.1.
      subject = validatedRequest.subject;
      authTime = validatedRequest.authTime;
      nonce = undefined;
    }

    // Choose access token issuer based on config (default: JWT).
    // Opaque tokens are recommended when immediate revocation is required,
    // since the resource server can call the introspection endpoint instead
    // of self-validating a JWT.
    const accessTokenIssuer: AccessTokenIssuer =
      config.accessTokenFormat === 'opaque'
        ? createOpaqueAccessTokenIssuer()
        : createJwtAccessTokenIssuer();

    // アクセストークンの audience を決定する（合成ポリシーは core の buildAccessTokenAudience に集約）。
    // RFC 9068 §3: JWT access token の aud は非空でなければならない。
    // このアクセストークンは常に OP 自身の UserInfo エンドポイントで使用できるため、UserInfo
    // エンドポイント（discovery が広告する userinfo_endpoint と同じ URL）を aud の恒久メンバとして
    // 必ず含める。resource 指定（validatedRequest.audience）があれば末尾に追加し、UserInfo
    // エンドポイントを取り除くことはしない。重複は除去される。
    // refresh では保存済み aud（既に UserInfo を含む）を引き継ぐため、再計算しても同一集合になる。
    const effectiveAudience = buildAccessTokenAudience({
      userInfoEndpoint: `${config.issuer}/userinfo`,
      requested: validatedRequest.audience,
      issuer: config.issuer,
    });

    // T-015: acr / amr resolver injection.
    // - authorization_code: pass acrResolver so the host app can decide acr / amr policy.
    // - refresh_token: pass stored acr / amr directly so OIDC Core 1.0 §12.1 SHOULD
    //   "preserve initial auth context" is satisfied; resolver is bypassed.
    const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
    const directAcr = validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : undefined;
    const directAmr = validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : undefined;

    // --- Refresh Token を発行するかの判定 -------------------------------------
    //
    // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types の既定は
    // ["authorization_code"]。refresh_token を登録していないクライアントへ RT を渡しても、
    // 次に grant_type=refresh_token を出した瞬間 validateClientGrantType が
    // unauthorized_client で拒否する。一度も使えない長期資格情報を保存させるだけなので
    // （RFC 9700 §4.14）、登録が無ければ発行しない。
    const clientAllowsRefreshGrant = clientAllowsRefreshTokenGrant(tokenClient);

    // RFC 6749 §6 / OIDC Core 1.0 §11: refresh 時の scope 縮小は当該リクエストの access token /
    // ID Token の権限縮小として扱い、refresh token rotation の可否とは切り離す。rotation 可否は
    // 「元の grant が offline_access を持っていたか」で判断する。
    // - authorization_code grant: 今回付与された scope に offline_access があるか。
    // - refresh_token grant: 元 refresh token の grant が offline_access を持っていたか
    //   (validatedRequest.hadOfflineAccess)。縮小後 scope から offline_access を落としても
    //   元 grant の権限は失われないため rotation を継続する。
    const grantHasOfflineAccess =
      clientAllowsRefreshGrant &&
      (validatedRequest.grantType === 'refresh_token'
        ? validatedRequest.hadOfflineAccess
        : validatedRequest.scope.includes('offline_access'));

    // online refresh token の束縛先セッション。
    // OIDC Core 1.0 §11 は offline_access を「End-User が居ない（not logged in）ときにも
    // 使える Refresh Token」と定義したうえで、Refresh Token の利用がその用途に限られない
    // ことも明示している（"The Authorization Server MAY grant Refresh Tokens in other
    // contexts"）。この OP はその other contexts を online refresh token として実装し、
    // ログインセッションへ束縛する。offline_access がある grant は束縛しない。
    // - authorization_code grant: 認可コードが持つ sessionId（ログイン時に確立したもの）。
    // - refresh_token grant: 元 RT の束縛をそのまま引き継ぎ、rotation で外れないようにする。
    const boundSessionId = grantHasOfflineAccess ? undefined : validatedRequest.sessionId;

    // 束縛先が分からなければ online refresh token は発行しない。ブラウザセッションを
    // 持たない経路（device authorization grant）が該当する。ログアウトで止まる保証を
    // 付けられない RT を配らないための fail-closed。
    const issueRefreshToken =
      clientAllowsRefreshGrant &&
      (grantHasOfflineAccess ||
        (config.onlineRefreshTokenEnabled && boundSessionId !== undefined));

    // --- Token response pipeline --------------------------------------------
    // Each step below is an independent core function, called in the same order
    // as core's generateTokenResponse(). Add your own ID Token claims by editing
    // idTokenPayload before it is signed, or swap in another issuer.

    // One timestamp for the whole response so the issued tokens and the stored
    // token metadata agree on iat / exp.
    const issuedAt = Math.floor(Date.now() / 1000);

    // RFC 9068 §2.2: iss / sub / aud / exp / iat / scope / client_id.
    // Add access token claims here before the payload is signed.
    const accessTokenPayload = buildAccessTokenPayload({
      issuer: config.issuer,
      subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      audience: effectiveAudience,
      expiresIn: config.accessTokenExpiresIn,
      issuedAt,
    });

    // JWT or opaque, chosen above from config.accessTokenFormat.
    const accessToken = await accessTokenIssuer.issue({
      payload: accessTokenPayload,
      privateKey,
      keyId,
    });

    // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
    // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
    // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
    let idToken: string | undefined;
    let resolvedAcr: string | undefined = undefined;
    let resolvedAmr: string[] | undefined = undefined;
    if (validatedRequest.scope.includes('openid')) {
      // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
      // The hash function follows the ID Token signing alg.
      const atHash = await computeAtHash(accessToken, idTokenPrivateKey);

      // T-015: acr / amr resolution.
      // - authorization_code: ask the host app's AcrResolver (acr_values / claims
      //   are forwarded so it can honor the request).
      // - refresh_token: pass the stored acr / amr directly so OIDC Core 1.0 §12.1
      //   "preserve initial auth context" holds; the resolver is bypassed.
      ({ acr: resolvedAcr, amr: resolvedAmr } = await resolveAcrAmr({
        subject,
        clientId: validatedRequest.clientId,
        acr: directAcr,
        amr: directAmr,
        acrResolver: validatedRequest.grantType === 'authorization_code' ? acrResolver : undefined,
        requestedAcrValues:
          validatedRequest.grantType === 'authorization_code' ? validatedRequest.acrValues : undefined,
        // OIDC Core 1.0 §5.5: the parsed claims request lets the resolver satisfy
        // id_token member requests (e.g. acr.values).
        claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
      }));

      const idTokenPayload = buildIdTokenPayload({
        issuer: config.issuer,
        subject,
        clientId: validatedRequest.clientId,
        scope: validatedRequest.scope,
        expiresIn: config.idTokenExpiresIn,
        issuedAt,
        atHash,
        nonce,
        authTime,
        acr: resolvedAcr,
        amr: resolvedAmr,
      });

      // Add your own ID Token claims here, e.g.:
      //   idTokenPayload.tenant_id = await lookupTenant(subject);

      idToken = await generateIdToken({
        payload: idTokenPayload,
        privateKey: idTokenPrivateKey,
        keyId: idTokenKeyId,
      });
    }

    // OIDC Core 1.0 §3.1.3.3 / RFC 6749 §5.1: the token response body.
    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer' as const,
      expires_in: config.accessTokenExpiresIn,
      id_token: idToken,
      scope: validatedRequest.scope.join(' '),
      refresh_token: issueRefreshToken ? generateRandomString(32) : undefined,
    };

    // Store access token info for UserInfo / Introspection / Revocation endpoints.
    // iat / nbf / audience / issuer are kept so RFC 7662 introspection can echo them.
    // grantId binds this token to the original authorization grant so it can be
    // revoked together with sibling tokens on code reuse (OAuth 2.1 Section 4.1.2).
    await accessTokenStore.set(tokenResponse.access_token, {
      sub: subject,
      clientId: validatedRequest.clientId,
      scope: validatedRequest.scope,
      expiresAt: issuedAt + config.accessTokenExpiresIn,
      grantId: validatedRequest.grantId,
      iat: issuedAt,
      // RFC 7519 §4.1.5 / RFC 7662 §2.2: persist nbf (= iat) for JWT and opaque
      // tokens alike so introspection reports a not-yet-valid token inactive and
      // can echo nbf. The JWT issuer emits the same nbf = iat inside the token.
      nbf: issuedAt,
      audience: effectiveAudience,
      issuer: config.issuer,
      // RFC 9068 §2.2 / RFC 7662 §2.2: persist the token identifier core minted
      // for this issuance so introspection can echo jti. It is also what makes
      // two same-second issuances distinct token strings (RS256 is deterministic),
      // so this store key never collides across grants.
      jti: accessTokenPayload.jti,
      // OIDC Core 1.0 §5.5: persist the authorization request's claims parameter
      // so the UserInfo endpoint can honor claims.userinfo members (e.g.
      // {"userinfo":{"name":{"essential":true}}}) independently of scope.
      claims: validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined,
    });

    // Store the new refresh token for rotation (OAuth 2.1 Section 4.3.1).
    // The same grantId / audience / authTime / nonce / acr / amr / azp is propagated through
    // rotations so descendants can be revoked on code reuse, the audience never expands,
    // and refresh で再発行する ID Token は OIDC Core 1.0 §12.1 に従い初回認証時の値を保持する。
    if (tokenResponse.refresh_token) {
      // authTime はここで必ず確定する: authorization_code 経由は authCode.authTime、
      // refresh_token 経由は validatedRequest.authTime（前段で代入済み）。
      const rtAuthTime = authTime;
      if (rtAuthTime === undefined) {
        throw new TokenError(
          TokenErrorCode.InvalidGrant,
          'authTime is required to issue a refresh token',
        );
      }
      // OAuth 2.1 §6.1: refresh token は initial issuance からの absolute lifetime のみで失効する。
      // rotation を跨いで originalIssuedAt を引き継ぎ、expiresAt はそこからの絶対的な期限で固定する。
      // sliding expiry は持たないため、リフレッシュを繰り返しても失効時刻は前に進まず、
      // 漏洩 RT の長期 abuse を防ぐ。
      // - authorization_code grant: 今回が初回発行なので originalIssuedAt = issuedAt。
      // - refresh_token grant: 元 RT の originalIssuedAt をそのまま引き継ぐ。
      const originalIssuedAt =
        validatedRequest.grantType === 'refresh_token'
          ? validatedRequest.originalIssuedAt
          : issuedAt;
      const refreshTokenExpiresAt = originalIssuedAt + config.refreshTokenAbsoluteLifetime;
      // RFC 6749 §6: 縮小後 scope（validatedRequest.scope）から offline_access が落ちても、
      // grant が offline_access を持つ限り次回以降の rotation を継続できるよう、永続化する
      // refresh token の scope には offline_access を保持する。access token は
      // validatedRequest.scope をそのまま使うため、当該リクエストの権限は縮小されたままになる。
      const refreshTokenScope =
        grantHasOfflineAccess && !validatedRequest.scope.includes('offline_access')
          ? [...validatedRequest.scope, 'offline_access']
          : validatedRequest.scope;
      await refreshTokenStore.set(tokenResponse.refresh_token, {
        subject,
        clientId: validatedRequest.clientId,
        scope: refreshTokenScope,
        expiresAt: refreshTokenExpiresAt,
        originalIssuedAt,
        used: false,
        grantId: validatedRequest.grantId,
        iat: issuedAt,
        issuer: config.issuer,
        audience: effectiveAudience,
        authTime: rtAuthTime,
        nonce,
        // OIDC Core 1.0 §12.1: refresh で再発行する ID Token は初回認証時の acr / amr を保持する。
        // - authorization_code grant: 直前で resolver が解決した値をそのまま永続化する。
        // - refresh_token grant: 既に保存済みの値を引き継ぐ（resolver は呼ばれていない）。
        acr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.acr : resolvedAcr,
        amr: validatedRequest.grantType === 'refresh_token' ? validatedRequest.amr : resolvedAmr,
        azp: validatedRequest.grantType === 'refresh_token' ? validatedRequest.azp : undefined,
        // online refresh token の束縛。undefined なら offline refresh token として
        // セッションから独立し、ログアウト後も使える。
        sessionId: boundSessionId,
      });
    }

    // OAuth 2.1 Section 4.3.1: ローテーションは新トークン保存成功後に旧 RT を失効する。
    // 失敗時にユーザーがリフレッシュ不能になることを防ぐため、必ずこの順序にする。
    if (validatedRequest.grantType === 'refresh_token' && params.refresh_token) {
      await refreshTokenResolver.revokeRefreshToken(params.refresh_token);
    }

    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(tokenResponse);
  } catch (error) {
    if (error instanceof IdJagError) {
      // ID-JAG errors use the RFC 6749 §5.2 shape and are always 400 — a 401
      // can only come from client authentication, which runs before both
      // branches and throws core's TokenError. Issuance failures map to
      // invalid_request / invalid_target / invalid_scope / unauthorized_client
      // (RFC 8693 §2.2.2); assertion failures on redemption map to
      // invalid_grant (RFC 7521 §4.1).
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.code, error_description: error.errorDescription },
        error.statusCode,
      );
    }
    if (error instanceof TokenError) {
      const status = error.statusCode as 400 | 401;
      // RFC 6750 Section 3 / OAuth 2.1 Section 5.2: 401 responses include WWW-Authenticate
      if (error.wwwAuthenticate) {
        c.header('WWW-Authenticate', error.wwwAuthenticate);
      }
      // RFC 6749 Section 5.2: error responses MUST set Cache-Control: no-store / Pragma: no-cache.
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        { error: error.error, error_description: error.errorDescription },
        status,
      );
    }
    // RFC 6749 Section 5.2: server_error responses MUST NOT be cached either.
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'server_error' }, 500);
  }
});
