import { toAgentUrn } from '@xaa/contracts';
import { isAbnormalReason } from '../../config.js';
import type { CleanupContext } from '../../clients/types.js';

/**
 * step5. Invalidates the Access Tokens already handed out.
 *
 * Stopping issuance does nothing about tokens that exist, so each Resource AS is asked
 * to revoke by actor — every grant whose `act.sub` is this agent, whatever their
 * remaining lifetime. Both AS are called every time, even when the agent only ever
 * touched one: this step's job is that nothing is left, not that nothing likely is.
 *
 * The upstream SaaS refresh token is a different matter. Revoking it breaks the
 * person's connection for every other agent too, so it happens only when the reason is
 * abnormal — a quarantine or a disabled identity — decided in one place so no call
 * site re-derives the condition.
 */
export async function credentialRevoke(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const actorSub = toAgentUrn(context.domain.agent_id);
  const failures: string[] = [];

  // Both are attempted before either failure is reported: an early return would leave
  // live tokens at the second resource because the first was briefly unreachable.
  for (const baseUrl of [context.clients.endpoints.docsAsUrl, context.clients.endpoints.financeAsUrl]) {
    try {
      const status = await context.clients.resourceAs.revokeByActor({ baseUrl, actorSub });
      if (status >= 500 || status === 0) failures.push(baseUrl);
    } catch {
      failures.push(baseUrl);
    }
  }

  if (isAbnormalReason(context.reason) && context.clients.endpoints.bridgeUrl && context.domain.idp_connection_id) {
    const status = await context.clients.bridge.revokeUpstream({
      baseUrl: context.clients.endpoints.bridgeUrl,
      connectionId: context.domain.idp_connection_id,
    });
    if (status >= 500 || status === 0) failures.push('bridge');
  }

  if (failures.length > 0) throw new Error('credential_revoke_failed');
  return 'succeeded';
}
