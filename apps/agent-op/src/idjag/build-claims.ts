import { buildIdJagClaims, type IdJagActor, type IdJagClaims, type IdJagSubject } from '@maronn-openid-connect/experimental/id-jag';
import { PLATFORM_CLIENT_ID, type IsolationLevel } from '@xaa/contracts';

export type IdJagClaimsWithIsolation = IdJagClaims & { isolation_level: IsolationLevel };

/**
 * REQ-05-076 / RULE-46. `sub` is the delegating human and `act.sub` is the agent;
 * `client_id` is always the single platform client, never the agent id (DEC-ID-22).
 * `iss` is the string Human IdP uses, byte for byte — it is not derived from this
 * service's own hostname (DEC-ID-03).
 *
 * `isolation_level` is added here because Finance Resource AS decides
 * `insufficient_isolation` from it, so there is no branch that leaves it out.
 * auth_time / acr / amr only appear when the subject_token carried them.
 */
export function buildClaims(options: {
  issuer: string;
  subject: IdJagSubject;
  audience: string;
  scope: string[];
  resource: string;
  actor: IdJagActor;
  isolationLevel: IsolationLevel;
  lifetimeSeconds: number;
  now: Date;
}): IdJagClaimsWithIsolation {
  const claims = buildIdJagClaims({
    issuer: options.issuer,
    subject: options.subject,
    audience: options.audience,
    clientId: PLATFORM_CLIENT_ID,
    scope: options.scope,
    resource: options.resource,
    actor: options.actor,
    lifetimeSeconds: options.lifetimeSeconds,
    now: options.now,
  });
  return { ...claims, isolation_level: options.isolationLevel };
}

export const ID_JAG_CLAIM_KEYS = [
  'iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat', 'scope', 'resource', 'act', 'isolation_level',
] as const;

export const OPTIONAL_SUBJECT_CLAIM_KEYS = ['auth_time', 'acr', 'amr'] as const;
