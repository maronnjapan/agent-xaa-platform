import { verifyGoogleServiceIdentity } from '@xaa/contracts';

export const PUSH_SERVICE_ACCOUNT_PREFIX = 'sa-pubsub-push@';

/**
 * Who may post to the push endpoint.
 *
 * Pub/Sub signs each delivery with an OIDC token for the subscription's service
 * account. Verifying the issuer, the audience and the caller's email is what keeps
 * `/internal/activity/push` from being an unauthenticated way to write rows into
 * anyone's timeline — the body names the `human_subject`, so the endpoint's only
 * defence is knowing that Pub/Sub sent it.
 */
export async function verifyPushCaller(input: {
  authorization: string | undefined;
  audience: string;
  fetchImpl?: typeof fetch;
}): Promise<{ email: string }> {
  const token = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7) : undefined;
  if (!token) throw new Error('missing push token');
  const claims = await verifyGoogleServiceIdentity(token, {
    audience: input.audience,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  const email = typeof claims.email === 'string' ? claims.email : '';
  if (!email.startsWith(PUSH_SERVICE_ACCOUNT_PREFIX)) throw new Error('unexpected push caller');
  return { email };
}
