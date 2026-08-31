import { JWT_TYP, assertAgentId } from '@xaa/contracts';
import type { ExecutionContext } from '../context/execution-context.js';
import { newJti } from './agent-assertion.js';

export const CLIENT_ASSERTION_LIFETIME_SECONDS = 120;

/**
 * Client authentication to the Agent OP — a different token from the actor token,
 * deliberately built by a different function.
 *
 * DEC-ID-11 keeps the two apart: same key, different `typ`, different lifetime,
 * separately numbered `jti`. A single builder with a `typ` parameter would make it
 * one edit away to present a client assertion as an actor token, and the OP checks
 * `typ` precisely because that confusion is the attack.
 */
export async function buildClientAssertion(
  context: ExecutionContext,
  path: string,
  now: number = Date.now(),
): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  assertAgentId(context.agentId);
  return context.agentClientKey.signCompactJws(
    { alg: 'ES256', typ: JWT_TYP.CLIENT_ASSERTION },
    {
      iss: context.agentId,
      sub: context.agentId,
      aud: `${context.agentOpBaseUrl}${path}`,
      exp: issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS,
      iat: issuedAt,
      jti: newJti(),
    },
  );
}
