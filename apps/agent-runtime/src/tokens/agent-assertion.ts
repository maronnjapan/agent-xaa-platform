import { randomBytes } from 'node:crypto';
import { encodeBase64Url } from '@xaa/crypto';
import { JWT_TYP, assertAgentId } from '@xaa/contracts';
import type { ExecutionContext } from '../context/execution-context.js';

export const ACTOR_TOKEN_LIFETIME_SECONDS = 300;

/** 128 bits, base64url. Short enough to log, long enough that a replay window is useless. */
export function newJti(): string {
  return encodeBase64Url(new Uint8Array(randomBytes(16)));
}

/**
 * The agent's own assertion of who it is, for the `actor_token` of the exchange.
 *
 * `aud` is built from AGENT_OP_BASE_URL rather than from the issuer string (DEV-15):
 * in the direct profile the token endpoint lives on a different host from the issuer,
 * so deriving it from the issuer would address the assertion to the wrong service.
 *
 * `iss` and `sub` are the bare agent id, not the URN. DEC-ID-10 puts the namespace on
 * `act.sub`, and it is the Agent OP that applies it — after checking that the assertion
 * came from the agent that authenticated. Sending a URN here would fail that check and
 * would also give the platform two spellings of the same identity.
 */
export async function buildActorToken(context: ExecutionContext, now: number = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  assertAgentId(context.agentId);
  return context.agentClientKey.signCompactJws(
    { alg: 'ES256', typ: JWT_TYP.ACTOR_TOKEN },
    {
      iss: context.agentId,
      sub: context.agentId,
      aud: `${context.agentOpBaseUrl}/xaa/token`,
      exp: issuedAt + ACTOR_TOKEN_LIFETIME_SECONDS,
      iat: issuedAt,
      jti: newJti(),
    },
  );
}
