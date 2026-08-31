import { Hono } from 'hono';
import { compile, AGENT_URN_PREFIX, SchemaValidationError } from '@xaa/contracts';
import type { RevocationLedger } from './revocation.js';

export const revokeByActorSchema = {
  $id: 'revoke-by-actor',
  type: 'object',
  additionalProperties: false,
  required: ['act_sub'],
  properties: { act_sub: { type: 'string', pattern: '^urn:xaa:agent:agent-[0-9a-z]{26}$' } },
} as const;

const assertBody: (value: unknown) => asserts value is { act_sub: string } = compile<{ act_sub: string }>(revokeByActorSchema);

export interface ServiceIdentityVerifier {
  /** Resolves to the caller's service account email, or null when untrusted. */
  verify(authorization: string | undefined): Promise<string | null>;
}

/**
 * T-RES-22. Lifecycle Cleanup calls this to stop every Access Token an agent holds.
 * Access Tokens are JWTs, so revocation is enforced by a ledger both Resource APIs
 * and both Authorization Servers consult.
 *
 * DPoP is not required here: the caller is a service account, not an agent. An
 * unknown actor answers 200 — the goal is that the actor ends up revoked, and
 * saying "no such actor" would leak which agents exist.
 */
export function createInternalRevokeRoute(options: {
  ledger: RevocationLedger;
  verifier: ServiceIdentityVerifier;
  lifecycleServiceAccount: string;
}): Hono {
  const app = new Hono();
  app.post('/', async (context) => {
    const caller = await options.verifier.verify(context.req.header('authorization'));
    if (caller !== options.lifecycleServiceAccount) return context.json({ error: 'forbidden' }, 403);

    let body: unknown;
    try {
      body = await context.req.json();
      assertBody(body);
    } catch (error) {
      if (error instanceof SchemaValidationError || error instanceof SyntaxError) return context.json({ error: 'invalid_request' }, 400);
      throw error;
    }
    const actSub = (body as { act_sub: string }).act_sub;
    if (!actSub.startsWith(AGENT_URN_PREFIX)) return context.json({ error: 'invalid_request' }, 400);
    await options.ledger.revoke(actSub);
    return context.json({ revoked: true });
  });
  return app;
}
