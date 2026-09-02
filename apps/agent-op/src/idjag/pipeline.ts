import {
  authorizeIdJagIssuanceClient, buildIdJagIssuanceResponse, IdJagError,
  parseIdJagIssuanceParams, resolveIdJagActorToken, TOKEN_TYPE_JWT,
  type IdJagIssuanceResponse,
} from '@maronn-openid-connect/experimental/id-jag';
import type { TokenClientInfo } from '@maronn-openid-connect/core';
import type { Es256Signer } from '@xaa/crypto';
import { PLATFORM_CLIENT_ID } from '@xaa/contracts';
import type { AgentRegistration, XaaStaticConfiguration } from '../store/types.js';
import type { JwkSet } from '../keys/shared-jwks.js';
import { assertAgentBinding, type DedicatedKeyBinding } from '../keys/dedicated-key.js';
import { createActorTokenResolver } from './actor-token-resolver.js';
import { ActorTokenReplayStore, verifyActorTokenFreshness } from './actor-token-replay.js';
import { attachCnf } from './attach-cnf.js';
import { buildClaims } from './build-claims.js';
import { capExp } from './cap-exp.js';
import { resolveSubject } from './resolve-subject.js';
import { signIdJag } from './sign-id-jag.js';
import { verifyAgentState, agentExpiryCheck } from './verify-agent-state.js';
import { verifyDelegation } from './verify-delegation.js';
import { assertDistinctIdentities } from './verify-namespace.js';
import { verifyXaaConfig, type XaaConfigField } from './verify-xaa-config.js';
import type { TokenExchangeTrace } from '../log/token-exchange-log.js';

/**
 * The 13 steps of DEC-ID-06, in order.
 *
 * The library's one-shot issuance helper is deliberately not used: the delegation
 * check, the expiry check, the resource check and the cnf attachment all have to sit
 * between library steps, and that helper offers no seam for them (DEV-08).
 */
export const STEP_NAMES = [
  'authorize_client', 'parse_params', 'resolve_subject', 'resolve_actor', 'delegation_check',
  'agent_state', 'validate_audience', 'validate_scope', 'validate_resource', 'build_claims',
  'attach_cnf_and_cap_exp', 'sign', 'build_response',
] as const;

export type StepName = (typeof STEP_NAMES)[number];

export interface IssuanceInput {
  params: Record<string, string>;
  issuer: string;
  registration: AgentRegistration;
  config: XaaStaticConfiguration;
  subjectTokenJwks: JwkSet;
  signer: Es256Signer;
  binding: DedicatedKeyBinding;
  dpopJkt: string;
  lifetimeSeconds: number;
  now: Date;
  replayStore: ActorTokenReplayStore;
  trace: TokenExchangeTrace;
  onViolation?: (code: 'delegation_mismatch' | 'xaa_config_out_of_range', detail: Record<string, unknown>) => void;
  onIssued?: (claims: Record<string, unknown>, kid: string) => void;
  recordStep?: (step: StepName) => void;
}

const CLIENT: TokenClientInfo = {
  clientId: PLATFORM_CLIENT_ID,
  clientType: 'confidential',
  grantTypes: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:token-exchange'],
} as unknown as TokenClientInfo;

export async function runIdJagIssuance(input: IssuanceInput): Promise<IdJagIssuanceResponse> {
  const step = (name: StepName) => input.recordStep?.(name);

  step('authorize_client');
  authorizeIdJagIssuanceClient(CLIENT);

  step('parse_params');
  // DEC-ID-19: refresh tokens are never subjects, and this is a literal, not a flag.
  const parsed = parseIdJagIssuanceParams(input.params, { allowRefreshTokenSubjects: false, allowActorTokens: true });
  if (!parsed.actorToken) throw new IdJagError('invalid_request', 'actor_token is required');
  if (parsed.actorTokenType !== TOKEN_TYPE_JWT) throw new IdJagError('invalid_request', 'actor_token_type is not supported');
  input.trace.requested_audience = parsed.audience;
  input.trace.requested_resource = parsed.resource ?? null;
  input.trace.requested_scope = parsed.scope ?? null;

  step('resolve_subject');
  const subject = await resolveSubject({
    subjectToken: parsed.subjectToken, issuer: input.issuer,
    clientId: PLATFORM_CLIENT_ID, jwks: input.subjectTokenJwks,
  });
  input.trace.subject_token_sub = subject.sub;
  input.trace.subject_token_iss = input.issuer;
  input.trace.subject_token_aud = PLATFORM_CLIENT_ID;

  step('resolve_actor');
  verifyActorTokenFreshness(parsed.actorToken, input.registration.agent_id, input.replayStore, input.now);
  const actor = await resolveIdJagActorToken({
    actorToken: parsed.actorToken, actorTokenType: parsed.actorTokenType,
    clientId: PLATFORM_CLIENT_ID, issuer: input.issuer, jwks: { keys: [] } as never,
    resolver: createActorTokenResolver({ authenticatedAgentId: input.registration.agent_id, registration: input.registration }),
  });
  input.trace.actor_token_sub = actor.sub;
  input.trace.actor_token_jti = actorJti(parsed.actorToken);

  step('delegation_check');
  assertDistinctIdentities(subject.sub, actor.sub);
  assertAgentBinding(input.binding, input.registration.agent_id);
  verifyDelegation({
    subjectSub: subject.sub, actorSub: actor.sub, registration: input.registration,
    onMismatch: (detail) => {
      input.trace.delegation_match = false;
      input.onViolation?.('delegation_mismatch', detail);
    },
  });
  input.trace.delegation_match = true;

  step('agent_state');
  input.trace.expiry_check = agentExpiryCheck(input.registration, input.now);
  verifyAgentState(input.registration, input.now);

  step('validate_audience');
  step('validate_scope');
  step('validate_resource');
  const scope = verifyXaaConfig({
    audience: parsed.audience, scope: parsed.scope, resource: parsed.resource,
    issuer: input.issuer, config: input.config,
    onViolation: (field: XaaConfigField) => input.onViolation?.('xaa_config_out_of_range', { field, agent_id: input.registration.agent_id }),
  });

  step('build_claims');
  const claims = buildClaims({
    issuer: input.issuer, subject, audience: parsed.audience, scope,
    resource: parsed.resource!, actor, isolationLevel: input.registration.isolation_level,
    lifetimeSeconds: input.lifetimeSeconds, now: input.now,
  });

  step('attach_cnf_and_cap_exp');
  const capped = capExp(attachCnf(claims, input.dpopJkt), new Date(input.registration.expires_at), input.now, input.lifetimeSeconds);

  step('sign');
  const idJag = await signIdJag(capped, input.signer);
  input.trace.issued_jti = String(capped.jti);
  input.trace.issued_kid = input.signer.kid;
  input.trace.issued_jkt = input.dpopJkt;
  input.onIssued?.(capped, input.signer.kid);

  step('build_response');
  const expiresIn = Number(capped.exp) - Number(capped.iat);
  return buildIdJagIssuanceResponse({ idJag, expiresIn, scope });
}

function actorJti(actorToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(actorToken.split('.')[1]!, 'base64url').toString('utf8')) as { jti?: unknown };
    return typeof payload.jti === 'string' ? payload.jti : null;
  } catch {
    return null;
  }
}
