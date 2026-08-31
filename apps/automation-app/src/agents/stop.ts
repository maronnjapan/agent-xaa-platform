import type { ControlPlaneClient } from '../http/control-plane-client.js';

/**
 * Stopping an agent is a request, not an action taken here.
 *
 * Destroying an agent means cancelling a Job Execution, scheduling key destruction and
 * writing a terminal status — all of which the Lifecycle Manager owns (RULE-27,
 * RULE-41). If this app could do any of it, two components would be deciding when an
 * agent's credentials stop working, and they would eventually disagree.
 *
 * The upstream status is passed straight through. Translating a 409 into a 200 would
 * tell the person their agent stopped when it did not.
 */
export async function stopAgent(input: {
  client: ControlPlaneClient;
  lifecycleManagerUrl: string;
  agentId: string;
}): Promise<Response> {
  return input.client.send('lifecycle-manager', {
    url: new URL(`/api/agents/${encodeURIComponent(input.agentId)}/revoke`, input.lifecycleManagerUrl).toString(),
    method: 'POST',
    requiredScope: 'agent:revoke',
  });
}
