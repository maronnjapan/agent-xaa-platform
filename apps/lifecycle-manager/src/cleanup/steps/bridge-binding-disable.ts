import type { CleanupContext } from '../../clients/types.js';

/**
 * step4. Disables the agent's bindings at the Bridge.
 *
 * With `enable_google_bridge=false` — the default — there is no Bridge in
 * endpoints.json and no binding in the domain, so this skips. That has to be a skip
 * rather than a failure, or every ordinary cleanup in the default profile would end
 * with a step it could never complete.
 */
export async function bridgeBindingDisable(context: CleanupContext): Promise<'succeeded' | 'skipped'> {
  const baseUrl = context.clients.endpoints.bridgeUrl;
  if (!baseUrl || context.domain.bridge_binding_ids.length === 0) return 'skipped';
  for (const bindingId of context.domain.bridge_binding_ids) {
    const status = await context.clients.bridge.disableBinding({ baseUrl, bindingId });
    if (status >= 500 || status === 0) throw new Error('bridge_disable_failed');
  }
  return 'succeeded';
}
