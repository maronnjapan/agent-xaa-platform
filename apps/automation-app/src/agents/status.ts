import { compile } from '@xaa/contracts';
import type { DocumentStore } from '@xaa/gcp';
import { agentStatusResponseSchema, AGENT_STATUS_RESPONSE_KEYS } from '../schemas/index.js';

export interface AgentStatusResponse {
  agent_status: string;
  remaining_seconds: number;
  current_task: string | null;
  tool_invocations: Array<{ tool_id: string; outcome: string; summary: string }>;
}

const assertResponse: (value: unknown) => asserts value is AgentStatusResponse =
  compile<AgentStatusResponse>(agentStatusResponseSchema);

export { AGENT_STATUS_RESPONSE_KEYS };

/**
 * Four values, copied out of the checkpoint by name.
 *
 * The response is built field by field rather than by spreading the checkpoint. The
 * checkpoint is written by the Runtime and can grow; a spread would forward whatever
 * it gained, and the one thing this endpoint must never do is hand a person's browser
 * something the Runtime happened to store (RULE-38). Building it by name means a new
 * checkpoint field is invisible here until someone adds it deliberately.
 */
export async function readAgentStatus(input: {
  documents: DocumentStore;
  agentId: string;
  now?: number;
}): Promise<AgentStatusResponse> {
  const now = input.now ?? Date.now();
  const meta = await input.documents.get<{ status?: string; expires_at?: string }>('agents', `${input.agentId}__meta`);
  const state = await input.documents.get<{
    agent_status?: string;
    task_context?: { task_id?: string };
    pending_tool_calls?: Array<Record<string, unknown>>;
  }>('agents', `${input.agentId}__state`);

  const expiresAt = meta?.expires_at ? Date.parse(meta.expires_at) : now;
  const response: AgentStatusResponse = {
    agent_status: state?.agent_status ?? meta?.status ?? 'CREATED',
    remaining_seconds: Math.max(0, Math.floor((expiresAt - now) / 1000)),
    current_task: state?.task_context?.task_id ?? null,
    tool_invocations: (state?.pending_tool_calls ?? []).map((call) => ({
      tool_id: String(call.tool_id ?? ''),
      outcome: String(call.outcome ?? ''),
      summary: String(call.reason ?? call.error_code ?? ''),
    })),
  };
  assertResponse(response);
  return response;
}
