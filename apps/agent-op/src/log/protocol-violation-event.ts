import { VIOLATION_MESSAGES, type ValidationCode } from '@xaa/contracts';

/** The six codes Agent OP can produce. Others belong to other services. */
export const AGENT_OP_VIOLATION_CODES = [
  'delegation_mismatch', 'xaa_config_out_of_range', 'invalid_dpop_proof',
  'replayed_dpop_proof', 'dpop_key_binding_mismatch', 'refresh_token_reuse',
] as const;

export type AgentOpViolationCode = (typeof AGENT_OP_VIOLATION_CODES)[number];

export interface ActivityEvent {
  event_type: 'PROTOCOL_VIOLATION';
  phase: 'security';
  outcome: 'blocked';
  message: string;
  agent_id: string | null;
  human_subject: string | null;
  task_id: string | null;
  detail: { violation_code: AgentOpViolationCode };
  occurred_at: string;
}

export interface ActivityPublisher {
  publish(topic: string, event: ActivityEvent): Promise<void>;
}

/** DEC-SEC-03: the only topic Agent OP publishes to. */
export const ACTIVITY_TOPIC = 'agent-activity-stream';

/**
 * REQ-11-018. `phase` and `outcome` are constants, not parameters: only Agent OP,
 * the Tool Executor and the native Resource AS may raise a PROTOCOL_VIOLATION, and
 * always in the same shape. Scripted demos never reach this path, so there is no
 * is_simulated argument (DEC-DEMO-01).
 */
export async function emitProtocolViolationEvent(
  publisher: ActivityPublisher,
  input: { violation_code: AgentOpViolationCode; agent_id: string | null; human_subject: string | null; task_id?: string | null; now?: () => number },
): Promise<void> {
  await publisher.publish(ACTIVITY_TOPIC, {
    event_type: 'PROTOCOL_VIOLATION',
    phase: 'security',
    outcome: 'blocked',
    message: VIOLATION_MESSAGES[input.violation_code as ValidationCode],
    agent_id: input.agent_id,
    human_subject: input.human_subject,
    task_id: input.task_id ?? null,
    detail: { violation_code: input.violation_code },
    occurred_at: new Date(input.now?.() ?? Date.now()).toISOString(),
  });
}
