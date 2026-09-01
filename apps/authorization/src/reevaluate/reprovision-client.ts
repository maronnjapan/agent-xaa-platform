export interface ReprovisionRequest {
  agentId: string;
  /** What the new agent must be provisioned with (00b §4). */
  effectiveCapabilities: string[];
  workDefinitionId: string;
  reason: string;
}

export type ReprovisionClient = (request: ReprovisionRequest) => Promise<void>;

export class ReprovisionRequestFailed extends Error {
  constructor(readonly agentId: string, readonly status: number) {
    super(`reprovision request failed: ${status}`);
    this.name = 'ReprovisionRequestFailed';
  }
}

/**
 * Asks Lifecycle Manager to replace an agent whose permissions narrowed. Authorization
 * decides; it never edits a running agent itself (RULE-14).
 *
 * The call carries a Google-issued OIDC ID Token for this service's own account, with
 * the destination's URL as the audience — Lifecycle's internal routes are closed to
 * anything that cannot present one (`ALLOWED_CALLER_SAS`). No DPoP: this is
 * service-to-service, not one of the three proof-bound paths of DEC-ID-13.
 *
 * `required_capabilities` is sent as the same set as `effective_capabilities`.
 * Authorization cannot claim the work needs more than the person still holds — sending
 * the pre-change proposal would abort every narrowing as `capability_insufficient`,
 * which is the very case this path exists to serve.
 */
export function createReprovisionClient(options: {
  lifecycleBaseUrl: string;
  identityToken: (audience: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}): ReprovisionClient {
  const send = options.fetchImpl ?? fetch;
  return async (request) => {
    const token = await options.identityToken(options.lifecycleBaseUrl);
    const url = new URL(
      `/internal/agents/${encodeURIComponent(request.agentId)}/reprovision`,
      options.lifecycleBaseUrl,
    ).toString();
    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        effective_capabilities: request.effectiveCapabilities,
        required_capabilities: request.effectiveCapabilities,
        work_definition_id: request.workDefinitionId,
      }),
    });
    if (!response.ok) throw new ReprovisionRequestFailed(request.agentId, response.status);
  };
}
