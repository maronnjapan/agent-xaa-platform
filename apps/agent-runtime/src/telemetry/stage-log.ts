import { randomBytes } from 'node:crypto';

/**
 * The transitions of docs 04 §6, in the order a tool call passes through them.
 *
 * A run that stops early emits fewer lines, and that is the signal: the missing stage
 * says where it stopped. Nothing back-fills the remaining stages with a failure marker,
 * because a line saying "we reached the resource API and failed" is not the same claim
 * as "we never got there", and the detection queries read the difference.
 */
export const STAGES = [
  'agent_intent', 'tool_selection', 'required_capability', 'auth_mapping',
  'agent_op', 'id_jag', 'token_endpoint', 'access_token', 'resource_api',
] as const;

export type Stage = (typeof STAGES)[number];

export interface StageFields {
  tool_id?: string;
  required_capability?: string;
  audience?: string;
  resource?: string;
  scope?: string;
  outcome?: string;
  operation?: string;
  latency_ms?: number;
}

const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export interface StageLogger {
  spanId: string;
  emit(stage: Stage, fields: StageFields): void;
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * REQ-04-028 and REQ-09-013 want different things from the same line — the operator
 * wants the tool and the outcome, the detection rules want the agent's age and its
 * expiry — so one writer produces both rather than two writers producing two views
 * that can disagree.
 *
 * `agent_age_seconds` is recomputed on every line. Caching it would make a long
 * reasoning run look like it aged only once, which is precisely what the lifetime
 * rules are watching for.
 */
export function createStageLogger(input: {
  executionId: string;
  agentId: string;
  taskId: string;
  createdAt: string;
  expiresAt: string;
  spanId?: string;
  now?: () => number;
  write?: (line: string) => void;
}): StageLogger {
  const createdAtMs = Date.parse(input.createdAt);
  const write = input.write ?? ((line: string) => process.stdout.write(line));
  const now = input.now ?? (() => Date.now());
  const spanId = input.spanId ?? newSpanId();
  return {
    spanId,
    emit(stage, fields) {
      const line: Record<string, unknown> = {
        execution_id: input.executionId,
        agent_id: input.agentId,
        task_id: input.taskId,
        tool_id: fields.tool_id ?? null,
        required_capability: fields.required_capability ?? null,
        audience: fields.audience ?? null,
        resource: fields.resource ?? null,
        scope: fields.scope ?? null,
        stage,
        outcome: fields.outcome ?? null,
        operation: fields.operation ?? null,
        agent_age_seconds: Math.floor((now() - createdAtMs) / 1000),
        expires_at: input.expiresAt,
        span_id: spanId,
        latency_ms: fields.latency_ms ?? null,
      };
      // Last gate before the line leaves the process. There is no `token` field to
      // begin with; this catches a value that arrived in one of the others.
      let sanitized = false;
      for (const [key, value] of Object.entries(line)) {
        if (typeof value === 'string' && JWT_SHAPE.test(value)) { delete line[key]; sanitized = true; }
      }
      if (sanitized) line.log_sanitized = true;
      write(`${JSON.stringify(line)}\n`);
    },
  };
}
